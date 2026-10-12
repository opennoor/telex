/** Durable destinations and Telegram reply ownership, shared by clients and the listener. */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processStart } from "./wake.ts";
import { statePath, withStateLock } from "./registry.ts";
import type { Incoming } from "./telegram.ts";

export type RouteRegistration = {
  id: string;
  chatId: number | string;
  provider: string;
  botName?: string;
  repo: string;
  branch: string;
  worktree: string;
  allowFrom?: number[];
  expiresAt?: number;
  pid?: number;
  processStart?: string;
};
type Selection = { chatId: string; fromId?: number; message: Incoming; routes: string[]; deadline: number };
type State = { routes: Record<string, RouteRegistration>; messages: Record<string, string>; selections: Record<string, Selection>; aliases?: Record<string, string> };
export type RouteStore = {
  register(route: RouteRegistration): void;
  rebind(from: string, route: RouteRegistration): void;
  aliases(id: string): string[];
  resolve(id: string): string;
  get(id: string): RouteRegistration | undefined;
  active(chatId: number | string): RouteRegistration[];
  remove(id: string, owner?: { pid: number; processStart?: string }): void;
  recordMessage(chatId: number | string, messageId: number, routeId: string): void;
  message(chatId: number | string, messageId: number): RouteRegistration | undefined;
  select(chatId: number | string, message: Incoming, routes: RouteRegistration[]): string;
  selection(id: string, index: number, chatId: number | string, fromId?: number): { route: RouteRegistration; message: Incoming } | undefined;
};
const visible = (value: string) => value.length > 80 ? `${value.slice(0, 79)}…` : value;
export const routeLabel = (route: RouteRegistration) =>
  [route.botName ?? "Telegram", route.provider, route.repo, route.branch, route.worktree, `session ${route.id}`].map(visible).join(" · ");
export const routeAuthorized = (route: RouteRegistration, chatId: number | string, fromId?: number) =>
  String(route.chatId) === String(chatId) && (!route.allowFrom?.length || (fromId !== undefined && route.allowFrom.includes(fromId)));

export function fileRoutes(token: string): RouteStore {
  return fileRoutesByHash(createHash("sha256").update(token).digest("hex"));
}

export function fileRoutesByHash(hash: string): RouteStore {
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("telex: invalid bot state identity");
  const path = join(dirname(statePath()), "routes", `${hash}.json`);
  const read = (): State => {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { return { routes: {}, messages: {}, selections: {} }; }
  };
  const change = <T>(fn: (state: State) => T): T => withStateLock(path, () => {
    const state = read();
    const result = fn(state);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
    return result;
  });
  const live = (route?: RouteRegistration) => {
    if (!route || route.expiresAt !== undefined && route.expiresAt <= Date.now()) return undefined;
    if (route.pid !== undefined) {
      try {
        process.kill(route.pid, 0);
        if (route.processStart && processStart(route.pid) !== route.processStart) return undefined;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EPERM") return undefined; }
    }
    return route;
  };
  const canonical = (state: State, id: string) => {
    const seen = new Set<string>();
    while (state.aliases?.[id] && !seen.has(id)) { seen.add(id); id = state.aliases[id]; }
    return id;
  };
  return {
    rebind: (from, route) => change((state) => {
      if (from === route.id) return;
      const existing = live(state.routes[route.id]);
      if (existing?.pid !== undefined && (existing.pid !== route.pid || existing.processStart !== route.processStart)) {
        throw new Error("telex: destination session is already connected");
      }
      state.routes[route.id] = route;
      delete state.routes[from];
      (state.aliases ??= {})[from] = route.id;
      for (const key of Object.keys(state.messages)) if (state.messages[key] === from) state.messages[key] = route.id;
    }),
    aliases: (id) => { const state = read(); return Object.keys(state.aliases ?? {}).filter((alias) => canonical(state, alias) === id); },
    resolve: (id) => canonical(read(), id),
    register: (route) => change((state) => {
      if (canonical(state, route.id) === route.id) state.routes[route.id] = route;
    }),
    get: (id) => { const state = read(); return live(state.routes[canonical(state, id)]); },
    active: (chatId) => Object.values(read().routes).filter((route) => live(route) && String(route.chatId) === String(chatId)),
    remove: (id, owner) => change((state) => {
      const route = state.routes[id];
      if (owner && route?.pid !== undefined && (route.pid !== owner.pid || (route.processStart !== undefined && route.processStart !== owner.processStart))) return;
      delete state.routes[id];
    }),
    recordMessage: (chatId, messageId, routeId) => change((state) => { state.messages[`${chatId}:${messageId}`] = routeId; }),
    message: (chatId, messageId) => { const state = read(); return live(state.routes[canonical(state, state.messages[`${chatId}:${messageId}`])]); },
    select: (chatId, message, routes) => change((state) => {
      const id = randomUUID();
      for (const [key, pending] of Object.entries(state.selections)) if (pending.deadline <= Date.now()) delete state.selections[key];
      state.selections[id] = { chatId: String(chatId), fromId: message.from_id, message, routes: routes.map((route) => route.id), deadline: Date.now() + 5 * 60_000 };
      return id;
    }),
    selection: (id, index, chatId, fromId) => change((state) => {
      const selection = state.selections[id];
      if (!selection || selection.deadline <= Date.now() || selection.chatId !== String(chatId) || selection.fromId !== fromId) return;
      const route = live(state.routes[canonical(state, selection.routes[index])]);
      if (!route || !routeAuthorized(route, chatId, fromId)) return;
      delete state.selections[id];
      return { route, message: selection.message };
    }),
  };
}

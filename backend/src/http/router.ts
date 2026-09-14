/**
 * A minimal router — no framework dependency, just enough structure to
 * keep route handlers in separate files instead of one growing if-chain in
 * server.ts. Path params via `:name` segments.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
}

export type RouteHandler = (ctx: RouteContext) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const patternStr = path
      .split("/")
      .map((segment) => {
        if (segment.startsWith(":")) {
          paramNames.push(segment.slice(1));
          return "([^/]+)";
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("/");
    this.routes.push({ method, pattern: new RegExp(`^${patternStr}$`), paramNames, handler });
  }

  get(path: string, handler: RouteHandler): void {
    this.add("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): void {
    this.add("POST", path, handler);
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const pathname = (req.url ?? "/").split("?")[0]!;
    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => (params[name] = decodeURIComponent(match[i + 1]!)));
      await route.handler({ req, res, params });
      return true;
    }
    return false;
  }
}

import { Hono } from "hono";
import { z } from "zod";
import type { Auth } from "../auth.ts";
import type { ClappArtifactRecord } from "./repositories.ts";
import type { ClappControlAction, ClappService } from "./service.ts";

/**
 * CLAPP-W1-007 — the thin, owner-scoped CLAPP HTTP surface.
 *
 * Follows the engine routes pattern exactly: every route reads the owner from
 * the app-level session middleware (`c.get("owner")`), bodies are zod-
 * validated (the create body by the service's strict frozen-spec schema, the
 * control body inline like the engine's own control route), errors map
 * honestly through the substrate's `AppError`/zod handling, and no domain
 * logic lives here. The only route-owned decoration is the substrate's own
 * signed-URL idiom: artifact records leave with a signed content URL, exactly
 * the way the browser and files routes derive theirs.
 */

/** Maps an artifact record to its route shape with a signed content URL. */
const decorateArtifact =
  (auth: Auth, owner: string) =>
  (record: ClappArtifactRecord): ClappArtifactRecord & { contentUrl: string } => ({
    ...record,
    contentUrl: auth.sign(owner, `/api/files/${record.fileId}/content`),
  });

export function clappRoutes(
  service: ClappService,
  auth: Auth,
): Hono<{ Variables: { owner: string } }> {
  const app = new Hono<{ Variables: { owner: string } }>();
  app.post("/reconstructions", async (c) => {
    const body = await c.req.json();
    return c.json(await service.createReconstruction(c.get("owner"), body), 201);
  });
  app.get("/reconstructions", async (c) => c.json(await service.list(c.get("owner"))));
  app.get("/reconstructions/:id", async (c) => {
    const owner = c.get("owner");
    const status = await service.status(owner, c.req.param("id"));
    const decorate = decorateArtifact(auth, owner);
    return c.json({ ...status, artifacts: status.artifacts.map(decorate) });
  });
  app.post("/reconstructions/:id/advance", async (c) =>
    c.json(await service.advance(c.get("owner"), c.req.param("id"))),
  );
  app.post("/reconstructions/:id/control", async (c) => {
    const { action } = z
      .object({ action: z.enum(["pause", "resume", "cancel", "retry"]) })
      .parse(await c.req.json());
    const controlAction: ClappControlAction = action;
    return c.json(await service.control(c.get("owner"), c.req.param("id"), controlAction));
  });
  return app;
}

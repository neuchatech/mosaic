import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.WARDROBE_API_PORT ?? 8788);

serve({ fetch: createApp().fetch, port }, (info) => {
  console.log(`Wardrobe Atlas API listening on http://localhost:${info.port}`);
});

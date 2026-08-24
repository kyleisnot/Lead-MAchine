// api/index.js — the Vercel entry point.
//
// Every route is rewritten here by vercel.json, and the Express app itself does the
// routing. server.js only calls app.listen() when process.env.VERCEL is unset, so
// importing it in a serverless function never binds a port.
import "../deploy-env.js";
import app from "../dashboard/server.js";

export default app;

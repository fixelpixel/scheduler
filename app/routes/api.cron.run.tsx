import { json, type ActionFunctionArgs, type LoaderFunctionArgs } from "@remix-run/node";

import {
  runScheduleJobForAllActiveShops,
  runScheduleJobForShop,
} from "../jobs/run-schedule-job.server";

let activeRun: Promise<Response> | null = null;

function parseBoolean(value: string | null): boolean {
  return value === "true" || value === "1";
}

function extractCronSecret(request: Request): string | null {
  const explicitHeader = request.headers.get("x-cron-secret");

  if (explicitHeader) {
    return explicitHeader;
  }

  const authHeader = request.headers.get("authorization");

  if (!authHeader) {
    return null;
  }

  const bearerPrefix = "Bearer ";

  return authHeader.startsWith(bearerPrefix) ? authHeader.slice(bearerPrefix.length) : authHeader;
}

async function handleCronRequest(request: Request) {
  if (activeRun) {
    return json({ ok: true, skipped: true, reason: "Scheduler run already in progress." });
  }

  activeRun = executeCronRequest(request).finally(() => {
    activeRun = null;
  });

  return activeRun;
}

async function executeCronRequest(request: Request) {
  const configuredSecret = process.env.CRON_SECRET;

  if (!configuredSecret) {
    return json({ ok: false, error: "CRON_SECRET is not configured." }, { status: 503 });
  }

  const providedSecret = extractCronSecret(request);

  if (!providedSecret || providedSecret !== configuredSecret) {
    return json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  const url = new URL(request.url);
  const shopDomain = url.searchParams.get("shop");
  const dryRun = parseBoolean(url.searchParams.get("dryRun"));
  const jobRunId = url.searchParams.get("jobRunId") ?? crypto.randomUUID();

  if (shopDomain) {
    const summary = await runScheduleJobForShop(shopDomain, {
      dryRun,
      jobRunId,
    });

    return json({ ok: true, scope: "shop", summary });
  }

  const summary = await runScheduleJobForAllActiveShops({
    dryRun,
    jobRunId,
  });

  return json({ ok: true, scope: "all", summary });
}

export const loader = async ({ request }: LoaderFunctionArgs) => handleCronRequest(request);

export const action = async ({ request }: ActionFunctionArgs) => handleCronRequest(request);

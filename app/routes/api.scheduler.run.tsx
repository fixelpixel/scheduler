import { json, type ActionFunctionArgs } from "@remix-run/node";

import { runScheduleJobForShop } from "../jobs/run-schedule-job.server";
import { authenticate } from "../shopify.server";

function parseBoolean(value: FormDataEntryValue | null): boolean {
  return value === "true" || value === "1";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, cors } = await authenticate.admin(request);
  const formData = await request.formData();
  const pageSizeValue = formData.get("pageSize");
  const parsedPageSize = pageSizeValue ? Number(pageSizeValue) : undefined;
  const pageSize =
    typeof parsedPageSize === "number" && Number.isFinite(parsedPageSize) && parsedPageSize > 0
      ? parsedPageSize
      : undefined;

  const summary = await runScheduleJobForShop(session.shop, {
    dryRun: parseBoolean(formData.get("dryRun")),
    pageSize,
    jobRunId: formData.get("jobRunId")?.toString() ?? crypto.randomUUID(),
  });

  return cors(json(summary));
};

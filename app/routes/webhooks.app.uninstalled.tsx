import type { ActionFunctionArgs } from "@remix-run/node";

import prisma from "../db.server";
import { shopRepository } from "../repositories/shop.repository.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  if (topic === "APP_UNINSTALLED") {
    await prisma.session.deleteMany({
      where: { shop },
    });

    await shopRepository.deactivateByShopDomain(shop);
  }

  return new Response(null, { status: 200 });
};

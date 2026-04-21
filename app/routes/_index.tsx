import { redirect, type LoaderFunctionArgs } from "@remix-run/node";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    return redirect(`/app?${url.searchParams.toString()}`);
  }

  return null;
};

export default function IndexRoute() {
  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", padding: "2rem" }}>
      <h1>Collection Scheduler</h1>
      <p>Please open this app from your Shopify Admin dashboard.</p>
    </main>
  );
}


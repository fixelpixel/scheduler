import {useEffect, useMemo, useState} from 'preact/hooks';

type CheckoutScheduleResponse = {
  mode: 'none' | 'countdown_to_end' | 'message';
  endDate: string | null;
  message: string | null;
  serverTime: string;
};

type Settings = {
  app_url?: unknown;
  shop_domain?: unknown;
};

type Merchandise = {
  id?: string;
  product?: {
    id?: string;
  };
};

type CartLine = {
  merchandise?: Merchandise;
};

type ShopifyCheckoutApi = {
  lines: {
    value?: CartLine[];
    subscribe?: (subscriber: (value: CartLine[]) => void) => () => void;
  };
  settings: {
    value?: Settings;
    subscribe?: (subscriber: (value: Settings) => void) => () => void;
  };
  shop?: {
    myshopifyDomain?: string;
  };
  i18n?: {
    translate?: (key: string) => string;
  };
};

declare const shopify: ShopifyCheckoutApi;

const EMPTY_RESPONSE: CheckoutScheduleResponse = {
  mode: 'none',
  endDate: null,
  message: null,
  serverTime: new Date().toISOString(),
};

export function CheckoutSchedule() {
  const [lines, setLines] = useState<CartLine[]>(() => shopify.lines.value ?? []);
  const [settings, setSettings] = useState<Settings>(
    () => shopify.settings.value ?? {},
  );
  const [schedule, setSchedule] =
    useState<CheckoutScheduleResponse>(EMPTY_RESPONSE);
  const [now, setNow] = useState(() => Date.now());

  const appUrl = normalizeAppUrl(settings.app_url);
  const shopDomain =
    normalizeShopDomain(shopify.shop?.myshopifyDomain) ||
    normalizeShopDomain(settings.shop_domain);

  const ids = useMemo(() => {
    const productIds = new Set<string>();
    const variantIds = new Set<string>();

    for (const line of lines) {
      const merchandise = line.merchandise;
      if (isProductVariantGid(merchandise?.id)) {
        variantIds.add(merchandise.id);
      }
      if (isProductGid(merchandise?.product?.id)) {
        productIds.add(merchandise.product.id);
      }
    }

    return {
      productIds: [...productIds],
      variantIds: [...variantIds],
    };
  }, [lines]);

  useEffect(() => {
    const unsubscribeLines = shopify.lines.subscribe?.((nextLines) => {
      setLines(nextLines);
    });
    const unsubscribeSettings = shopify.settings.subscribe?.((nextSettings) => {
      setSettings(nextSettings);
    });

    return () => {
      unsubscribeLines?.();
      unsubscribeSettings?.();
    };
  }, []);

  useEffect(() => {
    if (!appUrl || !shopDomain) {
      setSchedule(EMPTY_RESPONSE);
      return;
    }

    if (ids.productIds.length === 0 && ids.variantIds.length === 0) {
      setSchedule(EMPTY_RESPONSE);
      return;
    }

    const controller = new AbortController();
    const requestUrl = new URL('/api/checkout-schedule', appUrl);
    requestUrl.searchParams.set('shop', shopDomain);

    async function loadSchedule() {
      try {
        const response = await fetch(requestUrl.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            productIds: ids.productIds,
            variantIds: ids.variantIds,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          setSchedule(EMPTY_RESPONSE);
          return;
        }

        const data = (await response.json()) as Partial<CheckoutScheduleResponse>;
        setSchedule(normalizeResponse(data));
      } catch {
        if (!controller.signal.aborted) {
          setSchedule(EMPTY_RESPONSE);
        }
      }
    }

    void loadSchedule();

    return () => controller.abort();
  }, [appUrl, shopDomain, ids.productIds, ids.variantIds]);

  useEffect(() => {
    if (schedule.mode !== 'countdown_to_end' || !schedule.endDate) {
      return;
    }

    const serverOffset =
      new Date(schedule.serverTime).getTime() - Date.now();
    const interval = setInterval(() => {
      setNow(Date.now() + serverOffset);
    }, 1000);

    setNow(Date.now() + serverOffset);

    return () => clearInterval(interval);
  }, [schedule]);

  if (schedule.mode === 'message' && schedule.message) {
    return (
      <s-banner tone="info">
        <s-text>{schedule.message}</s-text>
      </s-banner>
    );
  }

  if (schedule.mode === 'countdown_to_end' && schedule.endDate) {
    const remaining = formatRemaining(schedule.endDate, now);

    if (!remaining) {
      return null;
    }

    return (
      <>
        <s-text emphasis="bold">{getStaticText('Orders close in')}</s-text>
        <s-text>{remaining}</s-text>
      </>
    );
  }

  return null;
}

function normalizeAppUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:') {
      return null;
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function normalizeShopDomain(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const domain = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)
    ? domain
    : null;
}

function isProductGid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^gid:\/\/shopify\/Product\/[0-9]+$/.test(value)
  );
}

function isProductVariantGid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^gid:\/\/shopify\/ProductVariant\/[0-9]+$/.test(value)
  );
}

function normalizeResponse(
  value: Partial<CheckoutScheduleResponse>,
): CheckoutScheduleResponse {
  const serverTime =
    typeof value.serverTime === 'string' && !Number.isNaN(Date.parse(value.serverTime))
      ? value.serverTime
      : new Date().toISOString();

  if (value.mode === 'message' && typeof value.message === 'string') {
    return {
      mode: 'message',
      message: value.message,
      endDate: null,
      serverTime,
    };
  }

  if (
    value.mode === 'countdown_to_end' &&
    typeof value.endDate === 'string' &&
    !Number.isNaN(Date.parse(value.endDate))
  ) {
    return {
      mode: 'countdown_to_end',
      message: null,
      endDate: value.endDate,
      serverTime,
    };
  }

  return {
    mode: 'none',
    message: null,
    endDate: null,
    serverTime,
  };
}

function formatRemaining(endDate: string, now: number): string | null {
  const diff = new Date(endDate).getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) {
    return null;
  }

  const totalSeconds = Math.floor(diff / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}

function getStaticText(fallback: string): string {
  const translated = shopify.i18n?.translate?.('checkout_schedule.orders_close_in');
  return translated && translated !== 'checkout_schedule.orders_close_in' ? translated : fallback;
}

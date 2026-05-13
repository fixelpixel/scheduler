(function () {
  start();

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    window.setTimeout(start, 250);
  }

  function start() {
    var roots = document.querySelectorAll("[data-scheduler-countdown]:not([data-scheduler-countdown-ready])");
    if (!roots.length) return;

    roots.forEach(function (root) {
      root.dataset.schedulerCountdownReady = "true";
      initCountdown(root);
    });
  }

  function initCountdown(root) {
    var content = root.querySelector("[data-scheduler-countdown-content]");
    var context = getContext(root);
    placeRoot(root);

    if (!content || !context.shop || !context.appUrl || (!context.collectionHandle && !context.productHandle)) {
      hide(root);
      return;
    }

    fetchSchedule(context)
      .then(function (schedule) {
        placeRoot(root);
        renderSchedule(root, content, schedule);
      })
      .catch(function () {
        hide(root);
      });
  }

  function getContext(root) {
    var urlContext = getCollectionProductUrlContext(window.location.pathname);
    var appUrl = normalizeAppUrl(root.dataset.appUrl || "");

    return {
      shop: cleanHandleLikeValue(root.dataset.shopDomain || ""),
      collectionHandle: cleanHandleLikeValue(root.dataset.collectionHandle || urlContext.collectionHandle || ""),
      productHandle: cleanHandleLikeValue(root.dataset.productHandle || urlContext.productHandle || ""),
      appUrl: appUrl,
    };
  }

  function placeRoot(root) {
    var pathname = window.location.pathname;
    var target = null;

    if (/\/products\/[^/]+/i.test(pathname)) {
      target =
        document.querySelector("product-form") ||
        document.querySelector(".product-form") ||
        document.querySelector('form[action*="/cart/add"]') ||
        document.querySelector("[data-product-form]") ||
        document.querySelector(".product__info-container") ||
        document.querySelector(".product__info-wrapper") ||
        document.querySelector(".product-form__buttons");
    } else if (/\/collections\/[^/]+/i.test(pathname)) {
      target =
        document.querySelector("#ProductGridContainer") ||
        document.querySelector(".product-grid-container") ||
        document.querySelector(".collection") ||
        document.querySelector(".collection-hero");
    }

    if (target && target.parentNode && target.parentNode !== root.parentNode) {
      target.parentNode.insertBefore(root, target);
    }
  }

  function getCollectionProductUrlContext(pathname) {
    var match = pathname.match(/\/collections\/([^/]+)\/products\/([^/?#]+)/i);
    if (!match) {
      return { collectionHandle: "", productHandle: "" };
    }

    return {
      collectionHandle: decodeURIComponent(match[1]),
      productHandle: decodeURIComponent(match[2]),
    };
  }

  function fetchSchedule(context) {
    var url = new URL("/api/storefront-schedule", context.appUrl);
    url.searchParams.set("shop", context.shop);

    if (context.collectionHandle) {
      url.searchParams.set("collectionHandle", context.collectionHandle);
    }

    if (context.productHandle) {
      url.searchParams.set("productHandle", context.productHandle);
    }

    return fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
    }).then(function (response) {
      if (!response.ok) throw new Error("Storefront schedule request failed.");
      return response.json();
    });
  }

  function renderSchedule(root, content, schedule) {
    if (!schedule || schedule.mode === "none") {
      hide(root);
      return;
    }

    applyVariant(root, schedule.noticeVariant || root.dataset.defaultVariant);

    if (schedule.mode === "message" && schedule.customMessage) {
      content.innerHTML = "";
      var message = document.createElement("p");
      message.className = "scheduler-countdown__message";
      message.textContent = schedule.customMessage;
      content.appendChild(message);
      show(root);
      return;
    }

    if (schedule.mode === "countdown_to_end" || schedule.mode === "countdown") {
      renderCountdown(root, content, schedule);
      return;
    }

    hide(root);
  }

  function renderCountdown(root, content, schedule) {
    var end = Date.parse(schedule.endDate || "");
    var server = Date.parse(schedule.serverTime || "");
    var offset = Number.isFinite(server) ? server - Date.now() : 0;
    var expiredBehavior = schedule.expiredBehavior === "show_expired_message" ? "show_expired_message" : "hide";

    if (!Number.isFinite(end)) {
      hide(root);
      return;
    }

    content.innerHTML =
      '<div class="scheduler-countdown__timer">' +
      '<span class="scheduler-countdown__label" data-scheduler-countdown-label></span>' +
      '<span class="scheduler-countdown__units" aria-label="Time remaining">' +
      unitMarkup("days", "Days") +
      unitMarkup("hours", "Hours") +
      unitMarkup("minutes", "Min") +
      unitMarkup("seconds", "Sec") +
      "</span>" +
      "</div>";

    var label = content.querySelector("[data-scheduler-countdown-label]");
    var values = {
      days: content.querySelector('[data-scheduler-countdown-unit="days"]'),
      hours: content.querySelector('[data-scheduler-countdown-unit="hours"]'),
      minutes: content.querySelector('[data-scheduler-countdown-unit="minutes"]'),
      seconds: content.querySelector('[data-scheduler-countdown-unit="seconds"]'),
    };

    function tick() {
      var now = Date.now() + offset;
      if (!Number.isFinite(end) || end <= now) {
        window.clearInterval(timer);
        renderExpired(root, content, expiredBehavior);
        return;
      }

      var remaining = end - now;

      if (remaining <= 0) {
        tick();
        return;
      }

      var parts = getTimeParts(remaining);
      if (label) {
        label.textContent = buildCountdownLabel(root, schedule);
      }

      values.days.textContent = String(parts.days);
      values.hours.textContent = pad(parts.hours);
      values.minutes.textContent = pad(parts.minutes);
      values.seconds.textContent = pad(parts.seconds);
      show(root);
    }

    var timer = window.setInterval(tick, 1000);
    tick();
  }

  function renderExpired(root, content, expiredBehavior) {
    if (expiredBehavior !== "show_expired_message") {
      hide(root);
      return;
    }

    content.innerHTML = "";
    var message = document.createElement("p");
    message.className = "scheduler-countdown__message scheduler-countdown__message--expired";
    message.textContent = "Ordering for this collection has closed.";
    content.appendChild(message);
    show(root);
  }

  function buildCountdownLabel(root, schedule) {
    var prefix = cleanText(schedule.label || "") || cleanText(root.dataset.countdownLabel || "") || "Orders close in";
    return schedule.collectionTitle ? prefix + " for " + schedule.collectionTitle : prefix;
  }

  function applyVariant(root, value) {
    var variant = normalizeVariant(value || root.dataset.defaultVariant || "");
    var variants = ["theme_native", "inline_product_form", "collection_bar", "compact_banner"];

    variants.forEach(function (name) {
      root.classList.remove("scheduler-countdown--" + name.replace(/_/g, "-"));
    });

    root.classList.add("scheduler-countdown--" + variant.replace(/_/g, "-"));
  }

  function unitMarkup(key, label) {
    return (
      '<span class="scheduler-countdown__unit">' +
      '<span class="scheduler-countdown__value" data-scheduler-countdown-unit="' +
      key +
      '">00</span>' +
      '<span class="scheduler-countdown__name">' +
      label +
      "</span>" +
      "</span>"
    );
  }

  function getTimeParts(milliseconds) {
    var totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    var days = Math.floor(totalSeconds / 86400);
    var hours = Math.floor((totalSeconds % 86400) / 3600);
    var minutes = Math.floor((totalSeconds % 3600) / 60);
    var seconds = totalSeconds % 60;

    return { days: days, hours: hours, minutes: minutes, seconds: seconds };
  }

  function cleanHandleLikeValue(value) {
    var trimmed = String(value || "").trim();
    return /^[a-z0-9][a-z0-9.-]*$/i.test(trimmed) ? trimmed : "";
  }

  function cleanText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeVariant(value) {
    var variant = String(value || "").trim();
    return /^(theme_native|inline_product_form|collection_bar|compact_banner)$/.test(variant)
      ? variant
      : "theme_native";
  }

  function normalizeAppUrl(value) {
    try {
      var url = new URL(String(value || "").trim());
      return url.protocol === "https:" ? url.origin : "";
    } catch (_error) {
      return "";
    }
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function show(root) {
    root.hidden = false;
    root.removeAttribute("aria-busy");
    root.classList.remove("is-empty", "is-loading");
  }

  function hide(root) {
    root.hidden = true;
    root.removeAttribute("aria-busy");
    root.classList.add("is-empty");
    root.classList.remove("is-loading");
  }
})();

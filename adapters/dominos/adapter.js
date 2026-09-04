DOMinAItrix.defineAdapter({
  meta: {
    id: "dominos",
    version: "0.2.0",
    route: () => location.pathname.startsWith("/menu")
      ? "menu"
      : location.pathname.startsWith("/deals")
        ? "deals"
        : "site",
  },
  tools: [
    {
      name: "list_dominos_menu_categories",
      description: "List menu categories available at the currently selected Domino's store. The user must select a store on Domino's first.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async (_args, { signal, ctx }) => {
        const { storeId } = readOrderContext(ctx);
        const data = await graphql(ctx, QUERIES.categories, { storeId }, signal);
        return result({ categories: (data.categories ?? []).map(({ id, name }) => ({ id, name })) });
      },
    },
    {
      name: "get_dominos_category",
      description: "Return products, base prices, stable product codes, and default variants for one Domino's menu category.",
      inputSchema: {
        type: "object",
        properties: {
          categoryId: { type: "string", minLength: 1, maxLength: 64, description: "Category ID from list_dominos_menu_categories." },
        },
        required: ["categoryId"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ categoryId }, { signal, ctx }) => {
        const { storeId } = readOrderContext(ctx);
        const id = validateCode(categoryId, "category", ctx);
        const data = await graphql(ctx, QUERIES.category, { storeId, categoryId: id }, signal);
        if (!data.category) throw ctx.error("state", "category_unavailable", "That category is not available at the selected store");
        return result({
          id: data.category.id,
          name: data.category.name,
          products: (data.category.products ?? []).filter((product) => !product.hidden).map(sanitizeCatalogProduct),
        });
      },
    },
    {
      name: "get_dominos_product_options",
      description: "Return valid bases, sizes, defaults, toppings, portions, and left/whole/right choices for a Domino's product. Pass a base or size to revalidate dependent options.",
      inputSchema: {
        type: "object",
        properties: {
          productCode: { type: "string", minLength: 1, maxLength: 64, description: "Product code from get_dominos_category." },
          baseCode: { type: "string", minLength: 1, maxLength: 64, description: "Optional crust or base code." },
          sizeCode: { type: "string", minLength: 1, maxLength: 64, description: "Optional size code." },
        },
        required: ["productCode"],
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ productCode, baseCode, sizeCode }, { signal, ctx }) => {
        const { storeId } = readOrderContext(ctx);
        const product = await fetchProduct(ctx, storeId, { productCode, baseCode, sizeCode }, signal);
        return result(sanitizeProductBuilder(product));
      },
    },
    {
      name: "list_dominos_deals",
      description: "List current local and national Domino's deals for the selected store and service method. Deal prices may omit store-calculated upcharges.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["all", "local", "national"], description: "Deal scope. Defaults to all." },
        },
      },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async ({ scope = "all" }, { signal, ctx }) => {
        if (!["all", "local", "national"].includes(scope)) throw ctx.error("input", "invalid_deal_scope", "The deal scope is invalid");
        const { storeId, serviceMethod } = readOrderContext(ctx);
        const data = await graphql(ctx, QUERIES.deals, { storeId, serviceMethod }, signal);
        const deals = (data.deals ?? []).filter((deal) => scope === "all" || Boolean(deal[scope]));
        return result({ serviceMethod, deals: deals.map(sanitizeDeal) });
      },
    },
    {
      name: "get_dominos_cart",
      description: "Return a sanitized summary of the current Domino's cart, including products, deal progress, discounts, and totals. The user must have an active cart.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: true },
      execute: async (_args, { signal, ctx }) => {
        const order = readOrderContext(ctx, { requireCart: true });
        return result(sanitizeCart(await fetchCart(ctx, order, signal)));
      },
    },
    {
      name: "start_dominos_deal",
      description: "Add an available Domino's deal to the current cart so its required product slots can be filled. This does not place an order.",
      inputSchema: {
        type: "object",
        properties: {
          dealCode: { type: "string", minLength: 1, maxLength: 64, description: "Deal code from list_dominos_deals." },
        },
        required: ["dealCode"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, untrustedContentHint: true },
      execute: async ({ dealCode }, { signal, ctx }) => {
        const code = validateCode(dealCode, "deal", ctx);
        const order = readOrderContext(ctx, { requireCart: true });
        const before = await fetchCart(ctx, order, signal);
        if (cartHasDeal(before, code)) return result({ dealCode: code, added: true, changed: false, cart: sanitizeCart(before) });

        const available = await graphql(ctx, QUERIES.deals, { storeId: order.storeId, serviceMethod: order.serviceMethod }, signal);
        if (!(available.deals ?? []).some((deal) => deal.code === code)) {
          throw ctx.error("state", "deal_unavailable", "That deal is not currently available for the selected store and service method");
        }

        const mutation = await graphql(ctx, QUERIES.addDeal, {
          dealCart: { storeId: order.storeId, cartId: order.cartId, dealCode: code },
        }, signal);
        if (!mutation.addDealToCart?.addDeal) throw ctx.error("state", "deal_add_rejected", "Domino's did not add the requested deal");
        const after = await fetchCart(ctx, order, signal);
        if (!cartHasDeal(after, code)) throw ctx.error("state", "deal_add_unconfirmed", "Domino's did not confirm the deal in the cart");
        return result({ dealCode: code, added: true, changed: true, cart: sanitizeCart(after) });
      },
    },
    {
      name: "add_dominos_product_to_cart",
      description: "Validate and add one configured Domino's product to the current cart, optionally into a started deal. This does not place an order.",
      inputSchema: {
        type: "object",
        properties: {
          productCode: { type: "string", minLength: 1, maxLength: 64, description: "Product code from get_dominos_category." },
          baseCode: { type: "string", minLength: 1, maxLength: 64, description: "Required crust or base code from get_dominos_product_options." },
          sizeCode: { type: "string", minLength: 1, maxLength: 64, description: "Required size code from get_dominos_product_options." },
          quantity: { type: "integer", minimum: 1, maximum: 20, description: "Number to add. Defaults to 1." },
          dealCode: { type: "string", minLength: 1, maxLength: 64, description: "Optional active deal code whose next compatible slot should receive the product." },
          options: {
            type: "array",
            maxItems: 40,
            description: "Non-default or explicitly customized product options.",
            items: {
              type: "object",
              properties: {
                code: { type: "string", minLength: 1, maxLength: 64, description: "Topping, sauce, cheese, seasoning, or other option code." },
                part: { type: "string", enum: ["LEFT", "WHOLE", "RIGHT"], description: "Pizza side. Defaults to WHOLE when supported." },
                portion: { type: "string", enum: ["LIGHT", "NORMAL", "EXTRA"], description: "Option amount. Defaults to NORMAL when supported." },
              },
              required: ["code"],
            },
          },
          sideOptions: {
            type: "array",
            maxItems: 20,
            description: "Dipping cups or other product-specific side add-ons.",
            items: {
              type: "object",
              properties: {
                code: { type: "string", minLength: 1, maxLength: 64, description: "Side-option code from get_dominos_product_options." },
                quantity: { type: "integer", minimum: 1, maximum: 20, description: "Number of this side option to add. Defaults to 1." },
              },
              required: ["code"],
            },
          },
        },
        required: ["productCode", "baseCode", "sizeCode"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, untrustedContentHint: true },
      execute: async ({ productCode, baseCode, sizeCode, quantity = 1, dealCode, options = [], sideOptions = [] }, { signal, ctx }) => {
        const order = readOrderContext(ctx, { requireCart: true });
        const requested = {
          productCode: validateCode(productCode, "product", ctx),
          baseCode: validateCode(baseCode, "base", ctx),
          sizeCode: validateCode(sizeCode, "size", ctx),
        };
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw ctx.error("input", "invalid_quantity", "Quantity must be an integer from 1 to 20");
        if (!Array.isArray(options) || options.length > 40) throw ctx.error("input", "invalid_options", "Product options must be an array of no more than 40 entries");
        if (!Array.isArray(sideOptions) || sideOptions.length > 20) throw ctx.error("input", "invalid_side_options", "Side options must be an array of no more than 20 entries");
        const activeDealCode = dealCode === undefined ? null : validateCode(dealCode, "deal", ctx);

        const before = await fetchCart(ctx, order, signal);
        if (activeDealCode && !cartHasDeal(before, activeDealCode)) {
          throw ctx.error("state", "deal_not_started", "Start the requested deal before adding a product to it");
        }
        const product = await fetchProduct(ctx, order.storeId, requested, signal);
        validateProductSelection(product, requested, ctx);
        const normalizedOptions = normalizeOptions(options, product, ctx);
        const normalizedSideOptions = normalizeSideOptions(sideOptions, product, ctx);

        const mutation = await graphql(ctx, QUERIES.addProduct, {
          input: {
            storeId: order.storeId,
            cartId: order.cartId,
            dealCode: activeDealCode,
            addToCartInput: {
              quantity,
              productCode: requested.productCode,
              size: requested.sizeCode,
              base: requested.baseCode,
              options: normalizedOptions,
              sideOptions: normalizedSideOptions,
            },
          },
        }, signal);
        if (mutation.addProductBuilder !== true) throw ctx.error("state", "product_add_rejected", "Domino's did not add the configured product");
        const after = await fetchCart(ctx, order, signal);
        if (cartQuantity(after) <= cartQuantity(before)) {
          throw ctx.error("state", "product_add_unconfirmed", "Domino's did not confirm the product in the cart");
        }
        return result({ added: true, productCode: requested.productCode, quantity, dealCode: activeDealCode, cart: sanitizeCart(after) });
      },
    },
    {
      name: "open_dominos_cart",
      description: "Open the Domino's cart overlay on the current page to display items and order summary to the user.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: false },
      execute: async (_args, { signal, ctx }) => {
        const dialog = document.querySelector('dialog, [role="dialog"]');
        if (dialog) return result({ opened: true, message: "Cart overlay is already open" });

        const button = document.querySelector('button[aria-label^="View cart"]')
          || document.querySelector('[data-quid="header-cart-button"]')
          || Array.from(document.querySelectorAll("button")).find((b) => /view cart/i.test(b.getAttribute("aria-label") || b.textContent));
        if (!button) throw ctx.error("state", "cart_button_missing", "Could not find the cart button on the page");

        // Verify that the UI cart count is in sync with the backend cart before opening.
        // If items were added via GraphQL mutations, Domino's in-memory React/Apollo state
        // may be stale until a page reload refreshes it from the server.
        try {
          const order = readOrderContext(ctx, { requireCart: true });
          const cart = await fetchCart(ctx, order, signal);
          const serverQty = cartQuantity(cart);
          const uiMatch = (button.getAttribute("aria-label") || button.textContent || "").match(/(\d+)\s+item/i);
          const uiQty = uiMatch ? parseInt(uiMatch[1], 10) : 0;
          if (serverQty > 0 && uiQty !== serverQty && typeof location?.reload === "function") {
            location.reload();
            return result({ opened: false, reloading: true, message: "Cart state was out of sync with the server; reloading page to display updated cart." });
          }
        } catch {
          // If reading context or fetching cart fails, proceed with opening the cart button
        }

        button.click();
        return result({ opened: true, message: "Cart overlay opened" });
      },
    },
    {
      name: "close_dominos_cart",
      description: "Close the Domino's cart overlay if it is currently open on the page.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false, untrustedContentHint: false },
      execute: async (_args, { ctx }) => {
        const dialog = document.querySelector('dialog, [role="dialog"]');
        if (!dialog) return result({ closed: true, message: "Cart overlay was not open" });
        const button = dialog.querySelector('button[aria-label="Close"], button:has(img[src*="close"])')
          || Array.from(dialog.querySelectorAll("button")).find((b) => /close/i.test(b.getAttribute("aria-label") || b.textContent));
        if (button) {
          button.click();
          return result({ closed: true, message: "Cart overlay closed" });
        }
        throw ctx.error("state", "close_button_missing", "Could not find the cart close button");
      },
    },
  ],
});

const GRAPHQL_URL = "/api/web-bff/graphql";
const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SERVICE_METHODS = new Set(["CARRYOUT", "DELIVERY", "HOTSPOT", "PICKUP_WINDOW", "DINE_IN", "CARSIDE"]);

const QUERIES = {
  categories: `query Categories($storeId: String!) { categories(storeId: $storeId) { id name } }`,
  category: `query Category($storeId: String!, $categoryId: String!) {
    category(storeId: $storeId, categoryId: $categoryId) {
      id name products { name description productType code categoryCode price size id path maxQuantity defaultVariant dealDefaultVariant isBuildYourOwn hidden }
    }
  }`,
  product: `query Product($input: ProductBuilderInput!) {
    product(input: $input) {
      name description productType selectedBase selectedSize quantity maxQuantity
      bases { value label description disabled disabledReason isNew upChargeDisclaimerLabel allowedSeasonings defaultSeasoning }
      sizes { code label description disabled }
      options {
        id label legend type additional hasParts hasPortions chargesDescription description
        values { value label description isDefault isDisabled portions parts }
      }
      sideOptions {
        id label legend type chargesDescription
        values { value label description defaultQuantity }
      }
      selectedOptions { optionGroup part portion value { option value { part portion value customizations } } }
    }
  }`,
  deals: `query Deals($storeId: String, $serviceMethod: ServiceMethod) {
    deals(storeId: $storeId, serviceMethod: $serviceMethod, componentImagesType: ALL) {
      code name shortDescription longDescription legalDescription discount price { dollars cents label quantifier symbol }
      hasSlots local national priceInfo validServiceMethods minimumCustomerAmount uiMinimumCustomerAmount
      effectiveOn expiresOn days noFutureOrder isPricePointDeal requiredPaymentType
    }
  }`,
  cart: `query CartById($storeId: String!, $cartId: String!) {
    getCart(storeId: $storeId, cartId: $cartId, market: "UNITED_STATES", locale: "en") {
      serviceMethod currency balanceDue isMissingProducts isMissingDeals
      charges { products subtotal tax total discounts adjustments royalty }
      summaryCharges { total subtotal youSaved }
      deals { code }
      products { id productCode name description quantity price menuPrice base modifiers { code quantity } }
      cartDeals {
        code name description priceInfo wholeCart isForcedIncomplete isBundle parentDealCode
        products { id productCode name description quantity price menuPrice base modifiers { code quantity } }
      }
    }
  }`,
  addDeal: `mutation AddDealToCart($dealCart: DealCartInput) {
    addDealToCart(dealCart: $dealCart) { addDeal }
  }`,
  addProduct: `mutation AddProductBuilderToCartMenu($input: AddProductBuilderToCartInput!) {
    addProductBuilder(addProductBuilderToCartInput: $input)
  }`,
};

async function graphql(ctx, query, variables, signal) {
  const payload = await ctx.http.json(GRAPHQL_URL, {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      market: "UNITED_STATES",
      "dpz-market": "UNITED_STATES",
      "dpz-language": "en",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (payload?.errors?.length) {
    const code = String(payload.errors[0]?.extensions?.code ?? "");
    if (/not\.found|unavailable/i.test(code)) throw ctx.error("state", "resource_unavailable", "Domino's reports that the requested item is unavailable");
    if (/bad\.request|validation/i.test(code)) throw ctx.error("input", "request_rejected", "Domino's rejected the requested configuration");
    throw ctx.error("http", "graphql_error", "Domino's could not complete the request");
  }
  if (!payload?.data) throw ctx.error("http", "graphql_response_missing", "Domino's returned an incomplete response");
  return payload.data;
}

function readOrderContext(ctx, { requireCart = false } = {}) {
  const cookies = parseCookies();
  const storeId = normalizeCookie(cookies.storeId);
  const cartId = normalizeCookie(cookies.cartId);
  const serviceMethod = normalizeServiceMethod(normalizeCookie(cookies.serviceMethod) || normalizeCookie(cookies.dispatchType));
  if (!/^\d{1,10}$/.test(storeId)) throw ctx.error("state", "store_not_selected", "Select a Domino's store before using this tool");
  if (requireCart && !/^[A-Za-z0-9-]{8,128}$/.test(cartId)) throw ctx.error("state", "cart_not_ready", "Start a Domino's cart before using this tool");
  return { storeId, cartId, serviceMethod };
}

function parseCookies() {
  return Object.fromEntries(String(document.cookie ?? "").split(";").map((pair) => {
    const index = pair.indexOf("=");
    if (index < 1) return ["", ""];
    return [decodeURIComponent(pair.slice(0, index).trim()), decodeURIComponent(pair.slice(index + 1))];
  }).filter(([key]) => key));
}

function normalizeCookie(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "string" || typeof parsed === "number" ? String(parsed) : text;
  } catch {
    return text.replace(/^['"]|['"]$/g, "");
  }
}

function normalizeServiceMethod(value) {
  const normalized = String(value || "CARRYOUT").trim().toUpperCase().replace(/[ -]+/g, "_");
  return SERVICE_METHODS.has(normalized) ? normalized : "CARRYOUT";
}

async function fetchProduct(ctx, storeId, input, signal) {
  const productCode = validateCode(input.productCode, "product", ctx);
  const variables = { input: { storeId, productCode } };
  if (input.baseCode !== undefined) variables.input.baseCode = validateCode(input.baseCode, "base", ctx);
  if (input.sizeCode !== undefined) variables.input.sizeCode = validateCode(input.sizeCode, "size", ctx);
  const data = await graphql(ctx, QUERIES.product, variables, signal);
  if (!data.product) throw ctx.error("state", "product_unavailable", "That product is not available at the selected store");
  return data.product;
}

async function fetchCart(ctx, order, signal) {
  const data = await graphql(ctx, QUERIES.cart, { storeId: order.storeId, cartId: order.cartId }, signal);
  if (!data.getCart) throw ctx.error("state", "cart_unavailable", "The current Domino's cart is unavailable");
  return data.getCart;
}

function validateProductSelection(product, requested, ctx) {
  const base = (product.bases ?? []).find((candidate) => candidate.value === requested.baseCode);
  const size = (product.sizes ?? []).find((candidate) => candidate.code === requested.sizeCode);
  if (!base || base.disabled) throw ctx.error("state", "base_unavailable", "The requested base is unavailable for this product");
  if (!size || size.disabled) throw ctx.error("state", "size_unavailable", "The requested size is unavailable for this base");
  if (product.selectedBase !== requested.baseCode || product.selectedSize !== requested.sizeCode) {
    throw ctx.error("state", "configuration_changed", "Domino's substituted a different base or size; refresh the product options and retry");
  }
}

function normalizeOptions(options, product, ctx) {
  const groups = product.options ?? [];
  const available = new Map();
  for (const group of groups) {
    for (const option of group.values ?? []) available.set(option.value, { group, option });
  }
  const seenCodes = new Set();
  const seenSingleGroups = new Set();
  return options.map((requested) => {
    const code = validateCode(requested?.code, "option", ctx);
    if (seenCodes.has(code)) throw ctx.error("input", "duplicate_option", "Each product option may be specified only once");
    seenCodes.add(code);
    const match = available.get(code);
    if (!match || match.option.isDisabled) throw ctx.error("state", "option_unavailable", "One of the requested product options is unavailable");
    if (match.group.type === "SINGLE" && seenSingleGroups.has(match.group.id)) {
      throw ctx.error("input", "conflicting_options", "Only one option may be selected from a single-choice group");
    }
    if (match.group.type === "SINGLE") seenSingleGroups.add(match.group.id);
    const allowedParts = match.option.parts ?? [];
    const allowedPortions = match.option.portions ?? [];
    const part = requested.part ?? (allowedParts.includes("WHOLE") ? "WHOLE" : allowedParts[0]);
    const portion = requested.portion ?? (allowedPortions.includes("NORMAL") ? "NORMAL" : allowedPortions[0]);
    if (requested.part !== undefined && !allowedParts.includes(part)) throw ctx.error("input", "invalid_option_part", "An option does not support the requested pizza side");
    if (requested.portion !== undefined && !allowedPortions.includes(portion)) throw ctx.error("input", "invalid_option_portion", "An option does not support the requested portion");
    const normalized = {
      code,
      quantity: 1,
      defaultQuantity: match.option.isDefault ? 1 : 0,
      isSeasoning: match.group.id === "SEASONING",
      isDefaultSeasoning: match.group.id === "SEASONING" && Boolean(match.option.isDefault),
    };
    if (part) normalized.part = part;
    if (portion) normalized.portion = portion;
    return normalized;
  });
}

function normalizeSideOptions(options, product, ctx) {
  const available = new Map((product.sideOptions ?? []).flatMap((group) => (group.values ?? []).map((option) => [option.value, option])));
  const seen = new Set();
  return options.map((requested) => {
    const code = validateCode(requested?.code, "side_option", ctx);
    if (seen.has(code)) throw ctx.error("input", "duplicate_side_option", "Each side option may be specified only once");
    seen.add(code);
    const option = available.get(code);
    if (!option) throw ctx.error("state", "side_option_unavailable", "One of the requested side options is unavailable");
    const quantity = requested.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw ctx.error("input", "invalid_side_option_quantity", "Side-option quantity must be an integer from 1 to 20");
    return { code, quantity, defaultQuantity: Number(option.defaultQuantity) || 0 };
  });
}

function validateCode(value, label, ctx) {
  const code = String(value ?? "").trim();
  if (!CODE_PATTERN.test(code)) throw ctx.error("input", `invalid_${label}_code`, `The ${label} code is invalid`);
  return code;
}

function sanitizeCatalogProduct(product) {
  return {
    code: product.code,
    name: product.name,
    description: product.description || null,
    productType: product.productType || null,
    basePrice: finiteNumber(product.price),
    size: product.size || null,
    defaultVariant: product.defaultVariant || null,
    dealDefaultVariant: product.dealDefaultVariant || null,
    path: product.path || null,
    maxQuantity: finiteNumber(product.maxQuantity),
  };
}

function sanitizeProductBuilder(product) {
  const groups = (values) => (values ?? []).map((group) => ({
    id: group.id,
    label: group.label,
    type: group.type,
    additional: Boolean(group.additional),
    hasParts: Boolean(group.hasParts),
    hasPortions: Boolean(group.hasPortions),
    chargesDescription: group.chargesDescription || null,
    options: (group.values ?? []).filter((option) => !option.isDisabled).map((option) => ({
      code: option.value,
      label: option.label,
      description: option.description || null,
      default: Boolean(option.isDefault),
      parts: option.parts ?? [],
      portions: option.portions ?? [],
    })),
  }));
  const sideGroups = (product.sideOptions ?? []).map((group) => ({
    id: group.id,
    label: group.label,
    type: group.type,
    chargesDescription: group.chargesDescription || null,
    options: (group.values ?? []).map((option) => ({
      code: option.value,
      label: option.label,
      description: option.description || null,
      defaultQuantity: Number(option.defaultQuantity) || 0,
    })),
  }));
  return {
    name: product.name,
    description: product.description || null,
    productType: product.productType || null,
    selectedBase: product.selectedBase || null,
    selectedSize: product.selectedSize || null,
    quantity: product.quantity,
    maxQuantity: product.maxQuantity,
    bases: (product.bases ?? []).map((base) => ({
      code: base.value,
      label: base.label,
      description: base.description || null,
      disabled: Boolean(base.disabled),
      disabledReason: base.disabledReason || null,
      upcharge: base.upChargeDisclaimerLabel || null,
    })),
    sizes: (product.sizes ?? []).map((size) => ({ code: size.code, label: size.label, description: size.description, disabled: Boolean(size.disabled) })),
    optionGroups: groups(product.options),
    sideOptionGroups: sideGroups,
    selectedOptions: (product.selectedOptions ?? []).map((selection) => ({
      group: selection.optionGroup,
      values: (selection.value ?? []).map((entry) => ({ code: entry.option, part: entry.value?.part, portion: entry.value?.portion })),
    })),
  };
}

function sanitizeDeal(deal) {
  return {
    code: deal.code,
    name: deal.name,
    description: deal.shortDescription || deal.longDescription || null,
    price: deal.price ? { label: deal.price.label, dollars: deal.price.dollars, cents: deal.price.cents, quantifier: deal.price.quantifier } : null,
    priceInfo: deal.priceInfo || null,
    discount: deal.discount || null,
    local: Boolean(deal.local),
    national: Boolean(deal.national),
    hasSlots: Boolean(deal.hasSlots),
    serviceMethods: deal.validServiceMethods ?? [],
    minimumCustomerAmount: finiteNumber(deal.minimumCustomerAmount ?? deal.uiMinimumCustomerAmount),
    effectiveOn: deal.effectiveOn ?? [],
    expiresOn: deal.expiresOn ?? [],
    days: deal.days ?? [],
    noFutureOrder: Boolean(deal.noFutureOrder),
    requiredPaymentType: deal.requiredPaymentType || null,
  };
}

function sanitizeCart(cart) {
  return {
    serviceMethod: cart.serviceMethod,
    currency: cart.currency,
    products: (cart.products ?? []).map(sanitizeCartProduct),
    deals: (cart.cartDeals ?? []).map((deal) => ({
      code: deal.code,
      name: deal.name,
      description: deal.description || null,
      priceInfo: deal.priceInfo || null,
      incomplete: Boolean(deal.isForcedIncomplete),
      wholeCart: Boolean(deal.wholeCart),
      parentDealCode: deal.parentDealCode || null,
      products: (deal.products ?? []).map(sanitizeCartProduct),
    })),
    appliedCoupons: (cart.deals ?? []).map((deal) => ({ code: deal.code })),
    charges: cart.charges ? {
      products: finiteNumber(cart.charges.products),
      subtotal: finiteNumber(cart.charges.subtotal),
      tax: finiteNumber(cart.charges.tax),
      discounts: finiteNumber(cart.charges.discounts),
      adjustments: finiteNumber(cart.charges.adjustments),
      total: finiteNumber(cart.charges.total),
    } : null,
    total: finiteNumber(cart.summaryCharges?.total ?? cart.balanceDue),
    subtotal: finiteNumber(cart.summaryCharges?.subtotal),
    savings: finiteNumber(cart.summaryCharges?.youSaved),
    missingProducts: Boolean(cart.isMissingProducts),
    missingDeals: Boolean(cart.isMissingDeals),
  };
}

function sanitizeCartProduct(product) {
  return {
    id: product.id,
    productCode: product.productCode,
    name: product.name,
    description: product.description || null,
    quantity: product.quantity,
    price: finiteNumber(product.price),
    menuPrice: finiteNumber(product.menuPrice),
    base: product.base || null,
    modifiers: (product.modifiers ?? []).map(({ code, quantity }) => ({ code, quantity })),
  };
}

function cartHasDeal(cart, code) {
  return (cart.cartDeals ?? []).some((deal) => deal.code === code)
    || (cart.deals ?? []).some((deal) => deal.code === code);
}

function cartQuantity(cart) {
  if (Array.isArray(cart.products) && cart.products.length > 0) {
    return cart.products.reduce((sum, product) => sum + (Number(product.quantity) || 0), 0);
  }
  return (cart.cartDeals ?? []).flatMap((deal) => deal.products ?? [])
    .reduce((sum, product) => sum + (Number(product.quantity) || 0), 0);
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

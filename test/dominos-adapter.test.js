import assert from "node:assert/strict";
import test from "node:test";
import { loadAdapter, parseToolResult } from "./helpers/adapter-harness.js";

const html = "<!doctype html><html><body><main>Domino's test fixture</main></body></html>";

test("Domino's adapter reads categories, product options, and deals", async () => {
  const harness = await loadDominos(async (_url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes("Categories")) return response({ categories: [{ id: "BuildYourOwn", name: "Build Your Pizza" }] });
    if (query.includes("Product")) return response({ product: productFixture() });
    if (query.includes("Deals")) return response({ deals: [{ code: "DEAL1", name: "Two-item deal", local: true, national: false, hasSlots: true, validServiceMethods: ["CARRYOUT"], price: { label: "$6.99 Each", dollars: "6", cents: "99", quantifier: "Each" } }] });
    throw new Error("Unexpected GraphQL operation");
  });

  assert.deepEqual(Object.keys(harness.tools), [
    "list_dominos_menu_categories",
    "get_dominos_category",
    "get_dominos_product_options",
    "list_dominos_deals",
    "get_dominos_cart",
    "start_dominos_deal",
    "add_dominos_product_to_cart",
    "open_dominos_cart",
    "close_dominos_cart",
  ]);
  const categories = parseToolResult(await harness.tools.list_dominos_menu_categories.execute({}, {}));
  assert.equal(categories.categories[0].id, "BuildYourOwn");
  const product = parseToolResult(await harness.tools.get_dominos_product_options.execute({ productCode: "S_PIZZA", baseCode: "HANDTOSS", sizeCode: "14" }, {}));
  assert.equal(product.optionGroups[0].options[0].code, "P");
  const deals = parseToolResult(await harness.tools.list_dominos_deals.execute({ scope: "local" }, {}));
  assert.equal(deals.deals[0].price.label, "$6.99 Each");
});

test("Domino's adapter validates and confirms a configured product addition", async () => {
  let cartReads = 0;
  let mutationVariables;
  const harness = await loadDominos(async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (query.includes("CartById")) {
      cartReads += 1;
      return response({ getCart: cartFixture(cartReads > 1 ? [{ id: "ITEM1", productCode: "S_PIZZA", name: "Pizza", quantity: 1, price: 15.49, menuPrice: 15.49, base: "HANDTOSS", modifiers: [{ code: "P", quantity: "1" }] }] : []) });
    }
    if (query.includes("AddProductBuilderToCartMenu")) {
      mutationVariables = variables;
      return response({ addProductBuilder: true });
    }
    if (query.includes("Product")) return response({ product: productFixture() });
    throw new Error("Unexpected GraphQL operation");
  });

  const output = parseToolResult(await harness.tools.add_dominos_product_to_cart.execute({
    productCode: "S_PIZZA",
    baseCode: "HANDTOSS",
    sizeCode: "14",
    options: [{ code: "P", part: "WHOLE", portion: "NORMAL" }],
    sideOptions: [{ code: "RANCH", quantity: 2 }],
  }, {}));
  assert.equal(output.added, true);
  assert.equal(output.cart.products[0].productCode, "S_PIZZA");
  assert.deepEqual(mutationVariables.input.addToCartInput.options[0], {
    code: "P",
    quantity: 1,
    defaultQuantity: 0,
    isSeasoning: false,
    isDefaultSeasoning: false,
    part: "WHOLE",
    portion: "NORMAL",
  });
  assert.deepEqual(mutationVariables.input.addToCartInput.sideOptions[0], {
    code: "RANCH",
    quantity: 2,
    defaultQuantity: 0,
  });
});

test("Domino's adapter rejects unavailable options before mutating", async () => {
  let mutated = false;
  const harness = await loadDominos(async (_url, options) => {
    const { query } = JSON.parse(options.body);
    if (query.includes("CartById")) return response({ getCart: cartFixture([]) });
    if (query.includes("AddProductBuilderToCartMenu")) mutated = true;
    if (query.includes("Product")) return response({ product: productFixture() });
    return response({ addProductBuilder: true });
  });
  await assert.rejects(
    harness.tools.add_dominos_product_to_cart.execute({ productCode: "S_PIZZA", baseCode: "HANDTOSS", sizeCode: "14", options: [{ code: "NOT_REAL" }] }, {}),
    (error) => error.code === "option_unavailable",
  );
  assert.equal(mutated, false);
});

test("Domino's adapter opens and closes the cart overlay", async () => {
  let opened = false;
  let closed = false;
  const customHtml = `<!doctype html><html><body>
    <button aria-label="View cart - 1 item" id="open-btn">View Cart</button>
    <div role="dialog" id="cart-dialog">
      <button aria-label="Close" id="close-btn">Close</button>
    </div>
  </body></html>`;

  const harness = await loadAdapter("../../adapters/dominos/adapter.js", customHtml, {
    url: "https://www.dominos.com/",
    cookie: "storeId=5351; cartId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee; serviceMethod=CARRYOUT",
  });

  const openBtn = harness.document.getElementById("open-btn");
  const dialog = harness.document.getElementById("cart-dialog");
  const closeBtn = harness.document.getElementById("close-btn");

  openBtn.addEventListener("click", () => { opened = true; });
  closeBtn.addEventListener("click", () => {
    closed = true;
    dialog.remove();
  });

  // When dialog is present, opening reports already open
  const alreadyOpenResult = parseToolResult(await harness.tools.open_dominos_cart.execute({}, {}));
  assert.equal(alreadyOpenResult.opened, true);

  // Close the dialog
  const closeResult = parseToolResult(await harness.tools.close_dominos_cart.execute({}, {}));
  assert.equal(closeResult.closed, true);
  assert.equal(closed, true);

  // Now that dialog is removed, open triggers button click
  const openResult = parseToolResult(await harness.tools.open_dominos_cart.execute({}, {}));
  assert.equal(openResult.opened, true);
  assert.equal(opened, true);
});

async function loadDominos(fetch) {
  return loadAdapter("../../adapters/dominos/adapter.js", html, {
    url: "https://www.dominos.com/menu",
    cookie: "storeId=5351; cartId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee; serviceMethod=CARRYOUT",
    fetch,
  });
}

function response(data) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
}

function productFixture() {
  return {
    name: "Pizza",
    productType: "Pizza",
    selectedBase: "HANDTOSS",
    selectedSize: "14",
    quantity: 1,
    maxQuantity: 20,
    bases: [{ value: "HANDTOSS", label: "Hand Tossed", disabled: false }],
    sizes: [{ code: "14", label: "Large", description: "14-inch", disabled: false }],
    options: [{ id: "MEAT", label: "Meats", type: "MULTIPLE", hasParts: true, hasPortions: true, values: [{ value: "P", label: "Pepperoni", isDefault: false, isDisabled: false, parts: ["LEFT", "WHOLE", "RIGHT"], portions: ["LIGHT", "NORMAL", "EXTRA"] }] }],
    sideOptions: [{ id: "DIPS", label: "Dipping Cups", type: "MULTIPLE", values: [{ value: "RANCH", label: "Ranch", defaultQuantity: 0 }] }],
    selectedOptions: [],
  };
}

function cartFixture(products) {
  return {
    serviceMethod: "CARRYOUT",
    currency: "USD",
    products,
    cartDeals: [],
    deals: [],
    charges: { products: 15.49, subtotal: 15.49, tax: 0, discounts: 0, adjustments: 0, total: 15.49 },
    summaryCharges: { total: 15.49, subtotal: 15.49, youSaved: 0 },
  };
}

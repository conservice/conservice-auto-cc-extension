const DEFAULT_SETTINGS = {
  enabled: true,
  ccAddresses: ["synergyfunding@conservice.com"],
};

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  "value"
).set;

// Pre-multi-address installs stored a single "ccAddress" string. Migrate it
// into the new "ccAddresses" array once, in place, so existing users don't
// lose their configured target on upgrade.
function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (items) => {
      if (!items.ccAddresses && items.ccAddress) {
        const migrated = {
          enabled: items.enabled !== undefined ? items.enabled : DEFAULT_SETTINGS.enabled,
          ccAddresses: [items.ccAddress],
        };
        chrome.storage.sync.set(migrated);
        resolve(migrated);
        return;
      }
      resolve({
        enabled: items.enabled !== undefined ? items.enabled : DEFAULT_SETTINGS.enabled,
        ccAddresses: items.ccAddresses && items.ccAddresses.length ? items.ccAddresses : DEFAULT_SETTINGS.ccAddresses,
      });
    });
  });
}

function setDefaultEnabled(enabled) {
  chrome.storage.sync.set({ enabled });
}

function setInputValue(input, value) {
  nativeInputValueSetter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findComposeRoot(toInput) {
  // Walk up to the NEAREST ancestor that contains a Send button at all.
  // Requiring an exact count of 1 is fragile in real usage — leftover
  // drafts/other compose windows can leave extra Send buttons elsewhere in
  // the DOM, which pushed this walk too far up (all the way to a near-root
  // container) and made the toggle row render at the top of the whole page
  // instead of inside the compose window. Stopping at the first ancestor
  // that contains any Send button is inherently narrow: since the To field
  // and Send button both belong to the same compose widget, the nearest
  // shared ancestor can only be that compose window's own container.
  let node = toInput.parentElement;
  for (let i = 0; i < 20 && node; i++) {
    if (node.querySelector('div[role="button"][aria-label="Send"]')) return node;
    node = node.parentElement;
  }
  return toInput.closest("table") || toInput.parentElement;
}

function getCcInput(root) {
  return root.querySelector('input[aria-label="CC recipients"], input[aria-label="Cc recipients"]');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Clicking "Add Cc recipients" doesn't render the Cc input synchronously —
// Gmail finishes wiring it up a beat later. Setting the value too early gets
// silently clobbered when that render catches up, so we wait it out.
async function revealCcField(root) {
  const existing = getCcInput(root);
  if (existing) return existing;
  const addCcLink = root.querySelector('span[aria-label*="Add Cc recipients"], span[role="link"][aria-label*="Cc"]');
  if (addCcLink) {
    addCcLink.click();
    await wait(150);
  }
  return getCcInput(root);
}

// Gmail can silently convert previously-inserted raw text into a real
// "chip" element on its own (e.g. once the user interacts elsewhere in the
// compose window), which clears the input's own .value — so checking
// .value alone misses an address that's already present as a chip and
// causes a duplicate entry. Check the whole recipient row's rendered text
// instead, which covers both chips and not-yet-committed raw text.
function ccRowAlreadyHasAddress(ccInput, address) {
  const row = ccInput.closest("tr") || ccInput.parentElement;
  const text = (row ? row.textContent : ccInput.value || "").toLowerCase();
  return text.includes(address.toLowerCase());
}

function focusToField(root) {
  const toInput = root.querySelector('input[aria-label="To recipients"], input[aria-label="To"]');
  if (toInput) toInput.focus();
}

async function addAddressesToCc(root, addresses) {
  const ccInput = await revealCcField(root);
  if (!ccInput) return;
  const missing = addresses.filter((address) => !ccRowAlreadyHasAddress(ccInput, address));
  if (!missing.length) return;
  const current = ccInput.value || "";
  const next = current.trim().length
    ? `${current.trim()}, ${missing.join(", ")}`
    : missing.join(", ");
  setInputValue(ccInput, next);
  focusToField(root);
}

function removeAddressesFromCc(root, addresses) {
  const ccInput = getCcInput(root);
  if (!ccInput) return;
  const lowerAddresses = addresses.map((a) => a.toLowerCase());
  const current = ccInput.value || "";
  const remaining = current
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length && !lowerAddresses.includes(s.toLowerCase()));
  setInputValue(ccInput, remaining.join(", "));
}

function buildToggleRow(root, settings) {
  const row = document.createElement("div");
  row.className = "sfac-toggle-row";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.id = `sfac-toggle-${Math.random().toString(36).slice(2)}`;
  checkbox.checked = settings.enabled;

  const label = document.createElement("label");
  label.htmlFor = checkbox.id;
  label.textContent = "Auto-CC ";

  const addressSpan = document.createElement("span");
  addressSpan.className = "sfac-address";
  addressSpan.textContent = `(${settings.ccAddresses.join(", ")})`;
  label.appendChild(addressSpan);

  checkbox.addEventListener("change", () => {
    setDefaultEnabled(checkbox.checked);
    if (checkbox.checked) {
      addAddressesToCc(root, settings.ccAddresses);
    } else {
      removeAddressesFromCc(root, settings.ccAddresses);
    }
  });

  row.appendChild(checkbox);
  row.appendChild(label);
  return row;
}

function insertToggleRow(root, toggleRow) {
  const subjectInput = root.querySelector('input[name="subjectbox"]');
  // subjectInput's *outer* <tr> is misleadingly named — Gmail nests the
  // entire rest of the compose form (body, toolbar, Send button) inside
  // that same row's cell, as descendants of a <form>. Inserting "after"
  // that <tr> lands after everything else in the compose window (visually
  // at the very bottom, by the Send button), not between Subject and the
  // body as intended. The Subject line's own immediate wrapper div (its
  // direct parentElement) is the right sibling boundary — it's a plain div
  // sitting alongside the body/toolbar divs within that nested form, so
  // inserting after it lands exactly between Subject and the body.
  const subjectWrapper = subjectInput ? subjectInput.parentElement : null;
  if (subjectWrapper) {
    subjectWrapper.insertAdjacentElement("afterend", toggleRow);
    return;
  }
  root.insertAdjacentElement("afterbegin", toggleRow);
}

async function initComposeInstance(toInput) {
  const root = findComposeRoot(toInput);
  if (!root) return;
  // Belt-and-suspenders guard against double-processing the same compose
  // window: a real DOM attribute on the root survives even if a later
  // mutation batch hands us a different (but equivalent) toInput reference.
  if (root.hasAttribute("data-sfac-init")) return;
  root.setAttribute("data-sfac-init", "true");

  const settings = await getSettings();
  const toggleRow = buildToggleRow(root, settings);
  insertToggleRow(root, toggleRow);

  if (settings.enabled) {
    await addAddressesToCc(root, settings.ccAddresses);
  }
}

function scanForComposeWindows() {
  document
    .querySelectorAll('input[aria-label="To recipients"], input[aria-label="To"]')
    .forEach((toInput) => {
      initComposeInstance(toInput);
    });
}

// Gmail replaces the "To recipients" input node at least once while a
// compose window finishes constructing (a placeholder gets swapped for the
// real widget), so a fresh mutation can hand us a brand-new node for what is
// conceptually the same compose window. Debouncing until mutations settle
// means we only ever see the final, stable node — the compose-root
// data-attribute guard in initComposeInstance is the second line of defense
// in case a settle window is still mid-swap.
let scanDebounceHandle = null;
const observer = new MutationObserver(() => {
  clearTimeout(scanDebounceHandle);
  scanDebounceHandle = setTimeout(scanForComposeWindows, 250);
});

observer.observe(document.body, { childList: true, subtree: true });

scanForComposeWindows();

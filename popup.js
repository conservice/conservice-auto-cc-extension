const DEFAULT_SETTINGS = {
  enabled: false,
  ccAddresses: [],
};

const enabledCheckbox = document.getElementById("enabled");
const ccListEl = document.getElementById("ccList");
const addCcButton = document.getElementById("addCc");
const statusEl = document.getElementById("status");

function addRow(value) {
  const row = document.createElement("div");
  row.className = "cc-entry";

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "group-or-person@conservice.com";
  input.value = value || "";
  input.addEventListener("change", save);

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.textContent = "✕";
  removeButton.title = "Remove";
  removeButton.addEventListener("click", () => {
    row.remove();
    save();
  });

  row.appendChild(input);
  row.appendChild(removeButton);
  ccListEl.appendChild(row);
  return input;
}

function currentAddresses() {
  return Array.from(ccListEl.querySelectorAll("input[type='text']"))
    .map((input) => input.value.trim())
    .filter((value) => value.length > 0);
}

function save() {
  const enabled = enabledCheckbox.checked;
  const addresses = currentAddresses();
  const ccAddresses = addresses.length ? addresses : DEFAULT_SETTINGS.ccAddresses;
  chrome.storage.sync.set({ enabled, ccAddresses }, () => {
    statusEl.textContent = "Saved. Applies to new compose windows.";
    setTimeout(() => (statusEl.textContent = ""), 2000);
  });
}

chrome.storage.sync.get(null, (items) => {
  enabledCheckbox.checked = items.enabled !== undefined ? items.enabled : DEFAULT_SETTINGS.enabled;

  const addresses =
    items.ccAddresses && items.ccAddresses.length
      ? items.ccAddresses
      : items.ccAddress
      ? [items.ccAddress]
      : DEFAULT_SETTINGS.ccAddresses;

  addresses.forEach((address) => addRow(address));
});

enabledCheckbox.addEventListener("change", save);
addCcButton.addEventListener("click", () => {
  const input = addRow("");
  input.focus();
});

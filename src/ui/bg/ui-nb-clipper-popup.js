/* global browser, document, fetch, window */

import { NORMANDY_BACKEND_URL } from "virtual:normandy-env";

const OTHER_ITEM_VALUE = "__other__";

const loginForm = document.getElementById("loginForm");
const usernameInput = document.getElementById("usernameInput");
const passwordInput = document.getElementById("passwordInput");
const loginButton = document.getElementById("loginButton");
const saveForm = document.getElementById("saveForm");
const clientSelect = document.getElementById("clientSelect");
const itemSelect = document.getElementById("itemSelect");
const customItemFields = document.getElementById("customItemFields");
const customItemInput = document.getElementById("customItemInput");
const saveButton = document.getElementById("saveButton");
const signedInActions = document.getElementById("signedInActions");
const settingsButton = document.getElementById("settingsButton");
const logoutButton = document.getElementById("logoutButton");
const status = document.getElementById("status");

let auth;
let apiUrl;
let savedSelection;
let selectionWritePromise = Promise.resolve();

loginForm.addEventListener("submit", login);
saveForm.addEventListener("submit", savePage);
clientSelect.addEventListener("change", clientChanged);
itemSelect.addEventListener("change", itemChanged);
customItemInput.addEventListener("input", customItemChanged);
settingsButton.addEventListener("click", openSettings);
logoutButton.addEventListener("click", logout);

initialize();

async function initialize() {
	apiUrl = NORMANDY_BACKEND_URL;
	const stored = await browser.storage.local.get(["nbClipperAuth", "nbClipperPopupSelection", "nbClipperLastUsername"]);
	auth = stored.nbClipperAuth;
	savedSelection = stored.nbClipperPopupSelection;
	if (stored.nbClipperLastUsername) {
		usernameInput.value = stored.nbClipperLastUsername;
	}
	if (auth && isCurrentJwt(auth.token)) {
		await showSaveForm();
	} else {
		if (auth) {
			const lastUsername = auth.username || auth.email;
			if (lastUsername) {
				await browser.storage.local.set({ nbClipperLastUsername: lastUsername });
				usernameInput.value = lastUsername;
			}
			await browser.storage.local.remove("nbClipperAuth");
		}
		showLoginForm();
	}
}

async function openSettings() {
	await browser.runtime.openOptionsPage();
	window.close();
}

async function logout() {
	await browser.storage.local.remove([
		"nbClipperAuth",
		"nbClipperSaveLocation",
		"nbClipperPopupSelection"
	]);
	auth = null;
	savedSelection = null;
	passwordInput.value = "";
	showLoginForm("Logged out. Log in with your Normandy account.");
}

function showLoginForm(message) {
	auth = null;
	saveForm.hidden = true;
	signedInActions.hidden = true;
	loginForm.hidden = false;
	setStatus(message || "Log in with your Normandy account.");
	if (!usernameInput.value) {
		usernameInput.focus();
	} else {
		passwordInput.focus();
	}
}

async function showSaveForm() {
	loginForm.hidden = true;
	saveForm.hidden = false;
	signedInActions.hidden = false;
	setStatus("Loading clients...");
	setSelectMessage(clientSelect, "Loading clients...");
	setSelectMessage(itemSelect, "Select a client first");
	try {
		const clients = await fetchRoute("save-locations",
			["displayName", "name"],
			["projectId", "name"],
			"folders");
		fillSelect(clientSelect, clients, "Select a client",
			savedSelection && (savedSelection.projectId || savedSelection.folderName || savedSelection.client));
		setStatus("");
		if (clientSelect.value) {
			await loadItems(clientSelect.value, savedSelection &&
				(savedSelection.subFolderName || savedSelection.item));
		}
	} catch (error) {
		await handleRequestError(error, "Could not load clients.");
	}
}

async function login(event) {
	event.preventDefault();
	setLoginPending(true);
	setStatus("Logging in...");
	const username = usernameInput.value.trim();
	try {
		const response = await fetch(`${apiUrl}/auth/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				username,
				// Older Normandy deployments use the email property for the same field.
				email: username,
				password: passwordInput.value
			})
		});
		const body = await readResponse(response, "Login failed.");
		if (!body.token) {
			throw new Error("The backend did not return a login token.");
		}
		if (!isCurrentJwt(body.token)) {
			throw new Error("The backend returned an invalid or expired login token.");
		}
		auth = {
			token: body.token,
			username: body.username || username,
			email: body.email || username
		};
		const stored = await browser.storage.local.get("nbClipperAuth");
		if (stored.nbClipperAuth &&
			(stored.nbClipperAuth.username || stored.nbClipperAuth.email) != (auth.username || auth.email)) {
			await browser.storage.local.remove(["nbClipperSaveLocation", "nbClipperPopupSelection"]);
			savedSelection = null;
		}
		await browser.storage.local.set({
			nbClipperAuth: auth,
			nbClipperLastUsername: auth.username || auth.email || username
		});
		passwordInput.value = "";
		await showSaveForm();
	} catch (error) {
		setStatus(error.message || "Could not log in.", true);
	} finally {
		setLoginPending(false);
	}
}

async function clientChanged() {
	const client = clientSelect.value;
	saveButton.disabled = true;
	hideCustomItemInput();
	await persistSelection("");
	if (!client) {
		setSelectMessage(itemSelect, "Select a client first");
		return;
	}
	await loadItems(client);
}

async function loadItems(client, selectedItem) {
	setSelectMessage(itemSelect, "Loading items...");
	setStatus("Loading items...");
	try {
		const items = await fetchRoute("subfolders",
			["subFolderName", "displayName", "name"],
			["subFolderName", "_id"],
			"items");
		fillSelect(itemSelect, items, "Select an item", selectedItem);
		itemSelect.add(new Option("Other", OTHER_ITEM_VALUE));
		itemSelect.disabled = false;
		if (selectedItem && !items.some(item => item.value == selectedItem)) {
			itemSelect.value = OTHER_ITEM_VALUE;
			customItemInput.value = selectedItem;
		}
		await itemChanged();
		setStatus("");
	} catch (error) {
		await handleRequestError(error, "Could not load items.");
	}
}

async function fetchRoute(route, labelKeys, valueKeys, collectionKey) {
	const response = await fetch(`${apiUrl}/nb-clipper/${route}`, {
		method: "GET",
		headers: {
			Authorization: `Bearer ${auth.token}`
		}
	});
	const responseBody = await readResponse(response, `Request to ${route} failed.`);
	return normalizeOptions(responseBody[collectionKey] || [], labelKeys, valueKeys);
}

async function readResponse(response, fallbackMessage) {
	const text = await response.text();
	let body;
	try {
		body = text ? JSON.parse(text) : {};
	} catch {
		body = {};
	}
	if (!response.ok) {
		const error = new Error(body.message || `${fallbackMessage} (HTTP ${response.status})`);
		error.status = response.status;
		throw error;
	}
	return body;
}

function normalizeOptions(values, labelKeys, valueKeys) {
	if (!Array.isArray(values)) {
		return [];
	}
	return values.map(value => {
		if (typeof value == "string") {
			return { label: value, value };
		}
		const labelKey = labelKeys.find(key => value && value[key]);
		const valueKey = valueKeys.find(key => value && value[key]);
		return labelKey && valueKey ? {
			label: String(value[labelKey]),
			value: String(value[valueKey]),
			folderName: value.name ? String(value.name) : "",
			projectId: value.projectId ? String(value.projectId) : "",
			customerId: value.customerId ? String(value.customerId) : "",
			jobNumber: value.jobNumber == null ? "" : String(value.jobNumber)
		} : null;
	}).filter(Boolean);
}

function fillSelect(select, options, placeholder, selectedValue) {
	select.replaceChildren(new Option(placeholder, ""));
	for (const option of options) {
		const optionElement = new Option(option.label, option.value);
		if (option.folderName) {
			optionElement.dataset.folderName = option.folderName;
		}
		if (option.projectId) {
			optionElement.dataset.projectId = option.projectId;
		}
		if (option.customerId) {
			optionElement.dataset.customerId = option.customerId;
		}
		if (option.jobNumber) {
			optionElement.dataset.jobNumber = option.jobNumber;
		}
		select.add(optionElement);
	}
	select.disabled = !options.length;

	// Prefer an exact project/value match. Older saved clipper selections only
	// stored the SharePoint folder name; do not silently choose the first match
	// when that folder now represents more than one project/job.
	const exactSelectedOption = options.find(option =>
		option.value == selectedValue
	);
	const folderMatches = options.filter(option =>
		option.folderName == selectedValue
	);
	const selectedOption = exactSelectedOption ||
		(folderMatches.length == 1 ? folderMatches[0] : null);

	if (selectedOption) {
		select.value = selectedOption.value;
	}
}

function setSelectMessage(select, message) {
	select.replaceChildren(new Option(message, ""));
	select.disabled = true;
}

async function itemChanged() {
	const customItemSelected = itemSelect.value == OTHER_ITEM_VALUE;
	customItemFields.hidden = !customItemSelected;
	customItemInput.required = customItemSelected;
	if (customItemSelected) {
		customItemInput.focus();
	} else {
		customItemInput.value = "";
	}
	refreshSaveButton();
	await persistSelection();
}

async function customItemChanged() {
	refreshSaveButton();
	await persistSelection();
}

async function persistSelection(itemNameOverride) {
	if (!clientSelect.value) {
		savedSelection = null;
		selectionWritePromise = selectionWritePromise.then(() =>
			browser.storage.local.remove("nbClipperPopupSelection")
		);
		await selectionWritePromise;
		return;
	}
	const selectedClient = clientSelect.selectedOptions[0];
	const itemName = itemNameOverride !== undefined ? itemNameOverride :
		(itemSelect.value == OTHER_ITEM_VALUE ?
			customItemInput.value.trim() : (itemSelect.value || ""));
	const selection = {
		projectId: selectedClient && selectedClient.dataset.projectId || "",
		folderName: selectedClient && selectedClient.dataset.folderName || clientSelect.value,
		subFolderName: itemName
	};
	savedSelection = selection;
	selectionWritePromise = selectionWritePromise.then(() =>
		browser.storage.local.set({ nbClipperPopupSelection: selection })
	);
	await selectionWritePromise;
}

function hideCustomItemInput() {
	customItemFields.hidden = true;
	customItemInput.required = false;
	customItemInput.value = "";
}

function refreshSaveButton() {
	const itemName = itemSelect.value == OTHER_ITEM_VALUE ?
		customItemInput.value.trim() : itemSelect.value;
	saveButton.disabled = !clientSelect.value || !itemName;
}

async function savePage(event) {
	event.preventDefault();
	setSavePending(true);
	setStatus("Starting save...");
	try {
		const itemName = itemSelect.value == OTHER_ITEM_VALUE ?
			customItemInput.value.trim() : itemSelect.value;
		const selectedClient = clientSelect.selectedOptions[0];
		const selection = {
			projectId: selectedClient && selectedClient.dataset.projectId || "",
			folderName: selectedClient && selectedClient.dataset.folderName || clientSelect.value,
			subFolderName: itemName
		};
		await browser.storage.local.set({ nbClipperPopupSelection: selection });
		const response = await browser.runtime.sendMessage({
			method: "ui.nbClipperPopup.save",
			selection
		});
		if (!response || !response.started) {
			throw new Error(response && response.error || "Could not start the save.");
		}
		window.close();
	} catch (error) {
		setStatus(error.message || "Could not start the save.", true);
		setSavePending(false);
	}
}

async function handleRequestError(error, fallbackMessage) {
	if (error.status == 401 || error.status == 403) {
		await browser.storage.local.remove("nbClipperAuth");
		showLoginForm("Your session expired. Please log in again.");
		return;
	}
	setStatus(error.message || fallbackMessage, true);
}

function setLoginPending(pending) {
	usernameInput.disabled = pending;
	passwordInput.disabled = pending;
	loginButton.disabled = pending;
}

function setSavePending(pending) {
	clientSelect.disabled = pending;
	itemSelect.disabled = pending;
	customItemInput.disabled = pending;
	saveButton.disabled = pending;
	if (!pending) {
		refreshSaveButton();
	}
}

function setStatus(message, error) {
	status.textContent = message;
	status.className = error ? "error" : "";
}

function isCurrentJwt(token) {
	if (typeof token != "string") {
		return false;
	}
	const parts = token.split(".");
	if (parts.length != 3) {
		return false;
	}
	try {
		const base64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
		const payload = JSON.parse(window.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
		return typeof payload.exp == "number" && payload.exp > Math.floor(Date.now() / 1000);
	} catch {
		return false;
	}
}

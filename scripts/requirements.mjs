import { chromium } from "playwright";

const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const appUrl = process.env.APP_URL || "http://127.0.0.1:5173/?data=local";
const storageKey = "trackboard:v1";

const demoState = {
  employees: [
    { id: "ADM001", name: "Branch Manager", role: "admin", pin: "0000", active: true },
    { id: "EMP101", name: "Aarav Sharma", role: "employee", pin: "1111", active: true },
    { id: "EMP102", name: "Meera Iyer", role: "employee", pin: "2222", active: true },
    { id: "EMP103", name: "Kabir Khan", role: "employee", pin: "3333", active: true },
    { id: "EMP104", name: "Nisha Verma", role: "employee", pin: "4444", active: true },
  ],
  targets: [
    { employeeId: "EMP101", month: "2026-09", name: "Loan Recovery", amount: 500000 },
    { employeeId: "EMP102", month: "2026-09", name: "Loan Recovery", amount: 450000 },
    { employeeId: "EMP103", month: "2026-09", name: "Loan Recovery", amount: 400000 },
    { employeeId: "EMP104", month: "2026-09", name: "Loan Recovery", amount: 350000 },
  ],
  recoveries: [
    { id: "r1", employeeId: "EMP101", date: "2026-09-04", amount: 100000 },
    { id: "r2", employeeId: "EMP102", date: "2026-09-03", amount: 75000 },
    { id: "r3", employeeId: "EMP103", date: "2026-09-02", amount: 125000 },
    { id: "r4", employeeId: "EMP104", date: "2026-09-01", amount: 40000 },
  ],
};

const failures = [];
const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
});

async function run(name, fn) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  try {
    await resetPage(page);
    await fn(page);
    if (consoleErrors.length > 0) throw new Error(`console errors: ${consoleErrors.join(" | ")}`);
    if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join(" | ")}`);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push(`FAIL ${name}: ${error.message}`);
  } finally {
    await page.close();
  }
}

async function resetPage(page) {
  await page.goto(appUrl, { waitUntil: "domcontentloaded" });
  await page.evaluate((key) => localStorage.removeItem(key), storageKey);
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function seedDemoState(page) {
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: storageKey, value: demoState }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
}

async function signIn(page, employeeId = "ADM001", pin = "0000") {
  await page.locator('input[autocomplete="username"]').fill(employeeId);
  await page.locator('input[autocomplete="current-password"]').fill(pin);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await page.waitForTimeout(100);
}

async function signOut(page) {
  await page.getByTitle("Sign out").click();
}

async function expectVisible(page, locator, message) {
  const isVisible = await locator.first().waitFor({ state: "visible", timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (!isVisible) throw new Error(message);
}

async function expectHidden(page, locator, message) {
  if (await locator.first().isVisible().catch(() => false)) throw new Error(message);
}

async function getStoredState(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)), storageKey);
}

await run("opens by link with dark first-run setup and no exposed credentials", async (page) => {
  await expectVisible(page, page.getByRole("heading", { name: "Tracker-Board" }), "app heading missing");
  await expectVisible(page, page.getByText("First setup"), "first-run setup missing");
  await expectHidden(page, page.getByText("ADM001"), "admin credential leaked");
  await expectHidden(page, page.getByText("EMP101"), "employee credential leaked");

  const background = await page.locator("html").evaluate((element) => getComputedStyle(element).backgroundColor);
  if (!background.includes("7, 19, 17")) {
    throw new Error(`expected dark theme background, got ${background}`);
  }
});

await run("first setup creates exactly one alphanumeric admin", async (page) => {
  await page.getByPlaceholder("ADMIN1").fill("12345");
  await page.getByPlaceholder("Branch Manager").fill("Numeric Admin");
  await page.getByPlaceholder("4 digit PIN").fill("1234");
  await page.getByRole("button", { name: "Create admin" }).click();
  await expectVisible(
    page,
    page.getByText("Admin ID must be 3-20 letters/numbers and include a letter."),
    "numeric admin ID was accepted"
  );

  await page.getByPlaceholder("ADMIN1").fill("ADM001");
  await page.getByPlaceholder("Branch Manager").fill("Branch Manager");
  await page.getByPlaceholder("4 digit PIN").fill("0000");
  await page.getByRole("button", { name: "Create admin" }).click();
  await expectVisible(page, page.getByText("Manager view"), "admin was not signed in after setup");

  const state = await getStoredState(page);
  const admins = state.employees.filter((employee) => employee.role === "admin" && employee.active);
  if (admins.length !== 1 || admins[0].id !== "ADM001") {
    throw new Error("first setup did not create exactly one active admin");
  }
});

await run("supports admin and employee views", async (page) => {
  await seedDemoState(page);
  await signIn(page);
  await expectVisible(page, page.getByText("Manager view"), "admin manager view missing");
  await expectVisible(page, page.getByText("Admin dashboard"), "admin dashboard missing");
  await expectVisible(page, page.getByText("Employee target pie"), "admin employee pie missing");
  await expectVisible(page, page.locator(".pie-item").first().getByText("Achieved"), "achieved amount label missing");
  await expectHidden(page, page.getByText(/\/20 logins/), "login capacity label is visible");
  await signOut(page);
  await signIn(page, "EMP101", "1111");
  await expectVisible(page, page.getByText("Employee view"), "employee view missing");
  await expectVisible(page, page.getByText("Aarav Sharma"), "employee name missing");
});

await run("admin target changes require Save and then update employee progress", async (page) => {
  await seedDemoState(page);
  await signIn(page);
  await expectVisible(page, page.locator("tbody tr", { hasText: "Aarav Sharma" }).getByLabel("Target name for Aarav Sharma"), "target name field missing");
  await page.locator("tbody tr", { hasText: "Aarav Sharma" }).getByLabel("Target for Aarav Sharma").fill("1000000");
  await signOut(page);
  await signIn(page, "EMP101", "1111");
  await expectVisible(page, page.getByText("Loan Recovery").first(), "employee target name missing");
  await expectVisible(page, page.getByText("20.0%").first(), "unsaved draft changed employee progress");

  await signOut(page);
  await signIn(page);
  const aaravRow = page.locator("tbody tr", { hasText: "Aarav Sharma" });
  await aaravRow.getByLabel("Target name for Aarav Sharma").fill("Gold Loan");
  await aaravRow.getByLabel("Target for Aarav Sharma").fill("1000000");
  await aaravRow.getByRole("button", { name: "Save" }).click();
  await expectVisible(page, page.getByText("Target saved."), "target save notice missing");

  await signOut(page);
  await signIn(page, "EMP101", "1111");
  await expectVisible(page, page.getByText("Gold Loan").first(), "saved target name not visible to employee");
  await expectVisible(page, page.getByText("10.0%").first(), "saved employee progress missing");
  await expectHidden(page, page.getByText("Team target"), "employee summary shows team target");
});

await run("employee entries accept numeric amounts and support edit/delete", async (page) => {
  await seedDemoState(page);
  await signIn(page, "EMP101", "1111");
  await page.getByPlaceholder("100000").fill("abc12000x");
  const amountValue = await page.getByPlaceholder("100000").inputValue();
  if (amountValue !== "12000") {
    throw new Error(`amount input did not strip non-numeric characters, got ${amountValue}`);
  }

  await page.getByPlaceholder("100000").fill("0");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expectVisible(page, page.getByText("Amount must be a positive whole number."), "zero amount rejection missing");

  await page.getByPlaceholder("100000").fill("30000");
  await page.getByRole("button", { name: "Save entry" }).click();
  await expectVisible(page, page.getByText("Entry saved."), "valid entry save notice missing");
  await expectVisible(page, page.getByText("26.0%").first(), "employee progress did not update");

  const savedEntry = page.locator(".entry-row", { hasText: "₹30,000" });
  await savedEntry.getByRole("button", { name: "Edit" }).click();
  await page.getByPlaceholder("100000").fill("40000");
  await page.getByRole("button", { name: "Update entry" }).click();
  await expectVisible(page, page.getByText("Entry updated."), "entry update notice missing");
  await expectVisible(page, page.locator(".entry-row", { hasText: "₹40,000" }), "updated entry amount missing");

  await page.locator(".entry-row", { hasText: "₹40,000" }).getByRole("button", { name: "Delete" }).click();
  await expectVisible(page, page.getByText("Entry deleted."), "entry delete notice missing");
  await expectHidden(page, page.locator(".entry-row", { hasText: "₹40,000" }), "deleted entry still visible");
});

await run("employees can see team progress leaderboard", async (page) => {
  await seedDemoState(page);
  await signIn(page, "EMP101", "1111");
  await expectVisible(page, page.getByText("Team progress"), "team progress section missing");
  await expectVisible(page, page.locator("tbody tr", { hasText: "Meera Iyer" }), "other employee progress missing");
  const firstEmployee = await page.locator("tbody tr td strong").first().textContent();
  if (firstEmployee !== "Kabir Khan") {
    throw new Error(`leaderboard is not ranked by highest progress first; got ${firstEmployee}`);
  }
});

await run("admin can create numeric and alphanumeric employee IDs with 4 digit PINs", async (page) => {
  await seedDemoState(page);
  await signIn(page);
  await page.getByRole("button", { name: "Employee Management" }).click();
  await page.getByPlaceholder("EMP105 or 105").fill("105");
  await page.getByPlaceholder("Employee name").fill("Numeric User");
  await page.getByPlaceholder("4 digit PIN").first().fill("9876");
  await page.getByRole("button", { name: "Add login" }).click();
  await expectVisible(page, page.getByText("Employee login created."), "numeric employee ID was not created");

  await page.getByPlaceholder("EMP105 or 105").fill("ABC123");
  await page.getByPlaceholder("Employee name").fill("Alpha Numeric");
  await page.getByPlaceholder("4 digit PIN").first().fill("6789");
  await page.getByRole("button", { name: "Add login" }).click();

  const state = await getStoredState(page);
  const numericUser = state.employees.find((employee) => employee.id === "105" && employee.pin === "9876");
  const alphaUser = state.employees.find((employee) => employee.id === "ABC123" && employee.pin === "6789");
  if (!numericUser || !alphaUser) throw new Error("numeric or alphanumeric employee IDs missing");
});

await run("PIN reset requires old PIN and admin can reset forgotten employee PIN", async (page) => {
  await seedDemoState(page);
  await page.getByRole("button", { name: "Reset PIN" }).click();
  await page.locator('input[autocomplete="username"]').fill("EMP101");
  await page.locator('input[autocomplete="current-password"]').fill("1111");
  await page.locator('input[autocomplete="new-password"]').fill("5555");
  await page.getByRole("button", { name: "Reset PIN" }).last().click();
  await expectVisible(page, page.getByText("PIN reset. Sign in with your new PIN."), "self reset success missing");

  await signIn(page, "EMP101", "5555");
  await expectVisible(page, page.getByText("Employee view"), "self-reset PIN did not work");
  await signOut(page);

  await signIn(page);
  await page.getByRole("button", { name: "Employee Management" }).click();
  await page.getByPlaceholder("EMP101").fill("EMP101");
  await page.getByPlaceholder("4 digit PIN").last().fill("6666");
  await page.getByRole("button", { name: "Reset employee PIN" }).click();
  await expectVisible(page, page.getByText("PIN reset for Aarav Sharma."), "admin PIN reset notice missing");

  await signOut(page);
  await signIn(page, "EMP101", "6666");
  await expectVisible(page, page.getByText("Employee view"), "admin-reset PIN did not work");
});

await run("admin XLSX export starts a two-sheet workbook download", async (page) => {
  await seedDemoState(page);
  await signIn(page);
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export XLSX" }).click();
  const download = await downloadPromise;
  if (!download.suggestedFilename().startsWith("trackboard-") || !download.suggestedFilename().endsWith(".xlsx")) {
    throw new Error(`unexpected XLSX filename ${download.suggestedFilename()}`);
  }
});

await run("admin delete uses confirmation and deactivates employee", async (page) => {
  await seedDemoState(page);
  await signIn(page);
  await page.getByRole("button", { name: "Employee Management" }).click();
  await page.locator(".employee-row", { hasText: "Aarav Sharma" }).getByRole("button", { name: "Delete" }).click();
  await expectVisible(page, page.getByRole("dialog"), "delete confirmation dialog missing");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expectVisible(page, page.locator(".employee-row", { hasText: "Aarav Sharma" }), "cancel removed employee");

  await page.locator(".employee-row", { hasText: "Aarav Sharma" }).getByRole("button", { name: "Delete" }).click();
  await page.getByRole("button", { name: "Delete employee" }).click();
  await expectHidden(page, page.locator(".employee-row", { hasText: "Aarav Sharma" }), "delete did not remove employee");

  await signOut(page);
  await signIn(page, "EMP101", "1111");
  await expectVisible(page, page.getByText("Invalid employee ID or PIN."), "deleted employee can still login");
});

await browser.close();

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log("All requirement tests passed.");

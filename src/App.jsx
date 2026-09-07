import { useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  CalendarDays,
  Download,
  KeyRound,
  Landmark,
  LogOut,
  Pencil,
  Plus,
  Save,
  Target,
  Trash2,
  Trophy,
  UserRound,
  UsersRound,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "./supabaseClient";

const STORAGE_KEY = "trackboard:v1";
const APP_NAME = "Tracker-Board";
const EMPLOYEE_ID_PATTERN = /^[a-z0-9]{3,20}$/i;
const ADMIN_ID_PATTERN = /^(?=.*[a-z])[a-z0-9]{3,20}$/i;
const PIN_PATTERN = /^\d{4}$/;
const SEARCH_PARAMS = new URLSearchParams(window.location.search);
const USE_SUPABASE =
  isSupabaseConfigured &&
  import.meta.env.VITE_TRACKBOARD_DATA_MODE !== "local" &&
  SEARCH_PARAMS.get("data") !== "local";

const emptyState = {
  employees: [],
  targets: [],
  recoveries: [],
};

function getCurrentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function getLastSixMonths() {
  const start = new Date();
  start.setDate(1);

  return Array.from({ length: 6 }, (_, index) => {
    const date = new Date(start);
    date.setMonth(start.getMonth() - index);
    return date.toISOString().slice(0, 7);
  });
}

function formatMonth(month) {
  const [year, rawMonth] = month.split("-");
  return new Date(Number(year), Number(rawMonth) - 1).toLocaleString("en-IN", {
    month: "short",
    year: "numeric",
  });
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function getMonthFromDate(date) {
  return date.slice(0, 7);
}

function clampProgress(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 999));
}

function xmlEscape(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function columnName(index) {
  let name = "";
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function sheetXml(rows) {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, cellIndex) => {
          const ref = `${columnName(cellIndex)}${rowIndex + 1}`;
          if (typeof cell === "number") {
            return `<c r="${ref}"><v>${cell}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function writeUint16(output, value) {
  output.push(value & 255, (value >>> 8) & 255);
}

function writeUint32(output, value) {
  output.push(value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255);
}

function createZip(files) {
  const encoder = new TextEncoder();
  const output = [];
  const centralDirectory = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const dataBytes = encoder.encode(file.content);
    const checksum = crc32(dataBytes);

    writeUint32(output, 0x04034b50);
    writeUint16(output, 20);
    writeUint16(output, 0);
    writeUint16(output, 0);
    writeUint16(output, 0);
    writeUint16(output, 0);
    writeUint32(output, checksum);
    writeUint32(output, dataBytes.length);
    writeUint32(output, dataBytes.length);
    writeUint16(output, nameBytes.length);
    writeUint16(output, 0);
    output.push(...nameBytes, ...dataBytes);

    const central = [];
    writeUint32(central, 0x02014b50);
    writeUint16(central, 20);
    writeUint16(central, 20);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, checksum);
    writeUint32(central, dataBytes.length);
    writeUint32(central, dataBytes.length);
    writeUint16(central, nameBytes.length);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint16(central, 0);
    writeUint32(central, 0);
    writeUint32(central, offset);
    central.push(...nameBytes);
    centralDirectory.push(central);
    offset = output.length;
  }

  const centralStart = output.length;
  for (const central of centralDirectory) output.push(...central);
  const centralSize = output.length - centralStart;

  writeUint32(output, 0x06054b50);
  writeUint16(output, 0);
  writeUint16(output, 0);
  writeUint16(output, files.length);
  writeUint16(output, files.length);
  writeUint32(output, centralSize);
  writeUint32(output, centralStart);
  writeUint16(output, 0);

  return new Uint8Array(output);
}

function createWorkbook(sheets) {
  const workbookSheets = sheets
    .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join("");
  const relationships = sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
    )
    .join("");
  const overrides = sheets
    .map(
      (_, index) =>
        `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("");

  return createZip([
    {
      name: "[Content_Types].xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}</Types>`,
    },
    {
      name: "_rels/.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      content: sheetXml(sheet.rows),
    })),
  ]);
}

function loadState() {
  if (USE_SUPABASE) return emptyState;

  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return emptyState;

  try {
    const saved = JSON.parse(raw);
    return { ...saved, targets: (saved.targets || []).map((target) => ({ ...target, id: target.id || crypto.randomUUID() })) };
  } catch {
    return emptyState;
  }
}

function normalizeRemoteState(snapshot) {
  return {
    employees: snapshot?.employees || [],
    targets: (snapshot?.targets || []).map((target) => ({
      ...target,
      amount: Number(target.amount || 0),
    })),
    recoveries: (snapshot?.recoveries || []).map((entry) => ({
      ...entry,
      amount: Number(entry.amount || 0),
    })),
  };
}

async function getRemoteSnapshot() {
  const { data, error } = await supabase.rpc("app_snapshot");
  if (error) throw error;
  return normalizeRemoteState(data);
}

function buildRows(state, month) {
  const employees = state.employees.filter((employee) => employee.role === "employee" && employee.active);

  return employees
    .map((employee) => {
      const targets = state.targets.filter(
        (item) => item.employeeId === employee.id && item.month === month
      );
      const target = targets.reduce((sum, item) => sum + Number(item.amount), 0);
      const targetName = targets.map((item) => item.name || "Monthly target").join(" + ") || "Monthly target";
      const recovered = state.recoveries
        .filter((item) => item.employeeId === employee.id && getMonthFromDate(item.date) === month)
        .reduce((sum, item) => sum + Number(item.amount), 0);
      const progress = target > 0 ? clampProgress((recovered / target) * 100) : 0;

      return { ...employee, targets, target, targetName, recovered, progress };
    })
    .sort((a, b) => b.progress - a.progress || b.recovered - a.recovered);
}

export default function App() {
  const [state, setState] = useState(loadState);
  const [session, setSession] = useState(null);
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const current = getCurrentMonth();
    return getLastSixMonths().includes(current) ? current : getLastSixMonths()[0];
  });
  const [setupForm, setSetupForm] = useState({ employeeId: "", name: "", pin: "" });
  const [loginForm, setLoginForm] = useState({ employeeId: "", pin: "" });
  const [authMode, setAuthMode] = useState("login");
  const [resetForm, setResetForm] = useState({ employeeId: "", currentPin: "", newPin: "" });
  const [adminPinForm, setAdminPinForm] = useState({ employeeId: "", newPin: "" });
  const [entryForm, setEntryForm] = useState({
    date: new Date().toISOString().slice(0, 10),
    amount: "",
  });
  const [editingEntryId, setEditingEntryId] = useState(null);
  const [employeeForm, setEmployeeForm] = useState({ id: "", name: "", pin: "" });
  const [targetDrafts, setTargetDrafts] = useState({});
  const targetDraftScope = useRef(null);
  const [deleteCandidate, setDeleteCandidate] = useState(null);
  const [notice, setNotice] = useState("");
  const [isLoading, setIsLoading] = useState(USE_SUPABASE);

  useEffect(() => {
    if (USE_SUPABASE) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state]);

  useEffect(() => {
    if (!USE_SUPABASE) return;

    let cancelled = false;
    setIsLoading(true);
    getRemoteSnapshot()
      .then((snapshot) => {
        if (!cancelled) setState(snapshot);
      })
      .catch(() => {
        if (!cancelled) flash("Could not load Supabase data. Check your project settings.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const months = useMemo(getLastSixMonths, []);
  const rows = useMemo(() => buildRows(state, selectedMonth), [state, selectedMonth]);
  const currentUser = session
    ? state.employees.find((employee) => employee.id === session.employeeId)
    : null;
  const isAdmin = currentUser?.role === "admin";
  const hasActiveAdmin = state.employees.some((employee) => employee.role === "admin" && employee.active);
  const ownRow = rows.find((row) => row.id === currentUser?.id);

  const totals = rows.reduce(
    (acc, row) => {
      acc.target += row.target;
      acc.recovered += row.recovered;
      return acc;
    },
    { target: 0, recovered: 0 }
  );
  const overallProgress = totals.target > 0 ? clampProgress((totals.recovered / totals.target) * 100) : 0;
  const summary = isAdmin
    ? {
        target: totals.target,
        recovered: totals.recovered,
        progress: overallProgress,
        targetLabel: "Team target",
        recoveredLabel: "Team amount",
        progressLabel: "Overall",
      }
    : {
        target: ownRow?.target || 0,
        recovered: ownRow?.recovered || 0,
        progress: ownRow?.progress || 0,
        targetLabel: ownRow?.targetName || "My target",
        recoveredLabel: "My amount",
        progressLabel: "My progress",
      };

  useEffect(() => {
    const scope = `${selectedMonth}:${currentUser?.id || ""}`;
    const preserve = targetDraftScope.current === scope;
    targetDraftScope.current = scope;
    setTargetDrafts((current) => Object.fromEntries(rows.map((row) => [row.id,
      preserve && current[row.id] ? current[row.id] : row.targets.length
        ? row.targets.map((target) => ({ ...target, amount: String(target.amount) }))
        : [{ id: crypto.randomUUID(), name: "Monthly target", amount: "" }],
    ])));
  }, [selectedMonth, state.targets, state.employees, currentUser?.id]);

  function flash(message) {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2500);
  }

  async function refreshRemoteState() {
    if (!USE_SUPABASE) return;
    setState(await getRemoteSnapshot());
  }

  async function setupAdmin(event) {
    event.preventDefault();

    if (hasActiveAdmin) {
      flash("Admin is already configured.");
      return;
    }
    if (!setupForm.employeeId.trim() || !setupForm.name.trim() || !setupForm.pin.trim()) {
      flash("Admin ID, name, and PIN are required.");
      return;
    }
    if (!ADMIN_ID_PATTERN.test(setupForm.employeeId.trim())) {
      flash("Admin ID must be 3-20 letters/numbers and include a letter.");
      return;
    }
    if (!PIN_PATTERN.test(setupForm.pin.trim())) {
      flash("PIN must be exactly 4 digits.");
      return;
    }

    const adminId = setupForm.employeeId.trim().toUpperCase();
    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_setup_admin", {
        employee_code_input: adminId,
        full_name_input: setupForm.name.trim(),
        plain_pin: setupForm.pin.trim(),
      });

      if (error || !data?.length) {
        flash(error?.message || "Admin setup failed.");
        return;
      }

      await refreshRemoteState();
      setSession({ employeeId: adminId, pin: setupForm.pin.trim() });
      setSetupForm({ employeeId: "", name: "", pin: "" });
      flash("Admin setup complete.");
      return;
    }

    setState({
      employees: [
        {
          id: adminId,
          name: setupForm.name.trim(),
          role: "admin",
          pin: setupForm.pin.trim(),
          active: true,
        },
      ],
      targets: [],
      recoveries: [],
    });
    setSession({ employeeId: adminId, pin: setupForm.pin.trim() });
    setSetupForm({ employeeId: "", name: "", pin: "" });
    flash("Admin setup complete.");
  }

  async function login(event) {
    event.preventDefault();
    if (!PIN_PATTERN.test(loginForm.pin)) {
      flash("PIN must be exactly 4 digits.");
      return;
    }

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_verify_pin", {
        employee_code_input: loginForm.employeeId.trim(),
        plain_pin: loginForm.pin,
      });
      const employee = data?.[0];

      if (error || !employee) {
        flash("Invalid employee ID or PIN.");
        return;
      }

      await refreshRemoteState();
      setSession({ employeeId: employee.employee_code, pin: loginForm.pin });
      flash(`Welcome, ${employee.full_name}.`);
      return;
    }

    const employee = state.employees.find(
      (item) =>
        item.id.trim().toLowerCase() === loginForm.employeeId.trim().toLowerCase() &&
        item.pin === loginForm.pin &&
        item.active
    );

    if (!employee) {
      flash("Invalid employee ID or PIN.");
      return;
    }

    setSession({ employeeId: employee.id, pin: loginForm.pin });
    flash(`Welcome, ${employee.name}.`);
  }

  async function resetPin(event) {
    event.preventDefault();

    if (!EMPLOYEE_ID_PATTERN.test(resetForm.employeeId.trim())) {
      flash("Enter a valid employee ID.");
      return;
    }
    if (!PIN_PATTERN.test(resetForm.currentPin) || !PIN_PATTERN.test(resetForm.newPin)) {
      flash("Both PINs must be exactly 4 digits.");
      return;
    }
    if (resetForm.currentPin === resetForm.newPin) {
      flash("New PIN must be different from old PIN.");
      return;
    }

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("reset_profile_pin", {
        employee_code_input: resetForm.employeeId.trim(),
        old_pin: resetForm.currentPin,
        new_pin: resetForm.newPin,
      });

      if (error || !data) {
        flash("Employee ID or old PIN is incorrect.");
        return;
      }

      setLoginForm({ employeeId: resetForm.employeeId.trim().toUpperCase(), pin: "" });
      setResetForm({ employeeId: "", currentPin: "", newPin: "" });
      setAuthMode("login");
      flash("PIN reset. Sign in with your new PIN.");
      return;
    }

    const employee = state.employees.find(
      (item) =>
        item.id.trim().toLowerCase() === resetForm.employeeId.trim().toLowerCase() &&
        item.pin === resetForm.currentPin &&
        item.active
    );

    if (!employee) {
      flash("Employee ID or old PIN is incorrect.");
      return;
    }

    setState((current) => ({
      ...current,
      employees: current.employees.map((item) =>
        item.id === employee.id ? { ...item, pin: resetForm.newPin } : item
      ),
    }));
    setLoginForm({ employeeId: employee.id, pin: "" });
    setResetForm({ employeeId: "", currentPin: "", newPin: "" });
    setAuthMode("login");
    flash("PIN reset. Sign in with your new PIN.");
  }

  async function saveTarget(employeeId, targetId) {
    if (!isAdmin) return;
    const draft = targetDrafts[employeeId]?.find((item) => item.id === targetId);
    if (!draft) return;
    const amount = draft.amount || "0";
    const name = draft.name.trim();
    const numericAmount = Number(amount);
    if (!name) {
      flash("Target name is required.");
      return;
    }
    if (!Number.isFinite(numericAmount) || numericAmount < 0 || numericAmount > 999999999999 || !/^\d+$/.test(String(amount))) {
      flash("Target must be a whole number.");
      return;
    }

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_save_target", {
        target_id_input: targetId,
        admin_code_input: currentUser.id,
        admin_pin: session.pin,
        employee_code_input: employeeId,
        month_input: selectedMonth,
        target_name_input: name,
        target_amount: numericAmount,
      });

      if (error || !data) {
        flash("Target could not be saved.");
        return;
      }

      await refreshRemoteState();
      flash("Target saved.");
      return;
    }

    setState((current) => {
      const existing = current.targets.some(
        (item) => item.id === targetId
      );

      return {
        ...current,
        targets: existing
          ? current.targets.map((item) =>
              item.id === targetId
                ? { ...item, name, amount: numericAmount }
                : item
            )
          : [...current.targets, { id: targetId, employeeId, month: selectedMonth, name, amount: numericAmount }],
      };
    });
    flash("Target saved.");
  }

  async function deleteTarget(employeeId, targetId) {
    if (!isAdmin) return;
    const saved = state.targets.find((target) => target.id === targetId);
    if (saved && !window.confirm(`Delete target "${saved.name}"? This cannot be undone.`)) return;

    if (saved && USE_SUPABASE) {
      try {
        const { data, error } = await supabase.rpc("app_delete_target", {
          target_id_input: targetId,
          admin_code_input: currentUser.id,
          admin_pin: session.pin,
        });
        if (error || !data) throw error || new Error("Delete failed");
      } catch {
        flash("Target could not be deleted.");
        return;
      }
    }

    setTargetDrafts((current) => ({ ...current,
      [employeeId]: (current[employeeId] || []).filter((target) => target.id !== targetId),
    }));
    setState((current) => ({ ...current,
      targets: current.targets.filter((target) => target.id !== targetId),
    }));
    flash(saved ? "Target deleted." : "Target row removed.");
  }

  async function addRecovery(event) {
    event.preventDefault();
    const amount = Number(entryForm.amount);

    if (!currentUser || currentUser.role !== "employee") return;
    if (!months.includes(getMonthFromDate(entryForm.date))) {
      flash("Entries are limited to the latest six months.");
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d+$/.test(entryForm.amount)) {
      flash("Amount must be a positive whole number.");
      return;
    }

    if (editingEntryId) {
      if (USE_SUPABASE) {
        const { data, error } = await supabase.rpc("app_update_recovery", {
          employee_code_input: currentUser.id,
          employee_pin: session.pin,
          entry_id_input: editingEntryId,
          recovery_date_input: entryForm.date,
          recovery_amount: amount,
        });

        if (error || !data) {
          flash("Entry could not be updated.");
          return;
        }

        await refreshRemoteState();
        setEditingEntryId(null);
        setSelectedMonth(getMonthFromDate(entryForm.date));
        setEntryForm({ date: new Date().toISOString().slice(0, 10), amount: "" });
        flash("Entry updated.");
        return;
      }

      setState((current) => ({
        ...current,
        recoveries: current.recoveries.map((entry) =>
          entry.id === editingEntryId ? { ...entry, date: entryForm.date, amount } : entry
        ),
      }));
      setEditingEntryId(null);
      setSelectedMonth(getMonthFromDate(entryForm.date));
      setEntryForm({ date: new Date().toISOString().slice(0, 10), amount: "" });
      flash("Entry updated.");
      return;
    }

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_add_recovery", {
        employee_code_input: currentUser.id,
        employee_pin: session.pin,
        recovery_date_input: entryForm.date,
        recovery_amount: amount,
      });

      if (error || !data) {
        flash("Entry could not be saved.");
        return;
      }

      await refreshRemoteState();
      setSelectedMonth(getMonthFromDate(entryForm.date));
      setEntryForm((current) => ({ ...current, amount: "" }));
      flash("Entry saved.");
      return;
    }

    setState((current) => ({
      ...current,
      recoveries: [
        {
          id: crypto.randomUUID(),
          employeeId: currentUser.id,
          date: entryForm.date,
          amount,
        },
        ...current.recoveries,
      ],
    }));
    setSelectedMonth(getMonthFromDate(entryForm.date));
    setEntryForm((current) => ({ ...current, amount: "" }));
    flash("Entry saved.");
  }

  function startEditEntry(entry) {
    setEditingEntryId(entry.id);
    setEntryForm({ date: entry.date, amount: String(entry.amount) });
  }

  function cancelEditEntry() {
    setEditingEntryId(null);
    setEntryForm({ date: new Date().toISOString().slice(0, 10), amount: "" });
  }

  async function deleteRecovery(entryId) {
    if (!currentUser || currentUser.role !== "employee") return;

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_delete_recovery", {
        employee_code_input: currentUser.id,
        employee_pin: session.pin,
        entry_id_input: entryId,
      });

      if (error || !data) {
        flash("Entry could not be deleted.");
        return;
      }

      await refreshRemoteState();
      if (editingEntryId === entryId) cancelEditEntry();
      flash("Entry deleted.");
      return;
    }

    setState((current) => ({
      ...current,
      recoveries: current.recoveries.filter((entry) => entry.id !== entryId),
    }));
    if (editingEntryId === entryId) cancelEditEntry();
    flash("Entry deleted.");
  }

  async function addEmployee(event) {
    event.preventDefault();

    if (!isAdmin) return;
    if (!employeeForm.id.trim() || !employeeForm.name.trim() || !employeeForm.pin.trim()) {
      flash("Employee ID, name, and PIN are required.");
      return;
    }
    if (!EMPLOYEE_ID_PATTERN.test(employeeForm.id.trim())) {
      flash("Employee ID must be 3-20 letters or numbers.");
      return;
    }
    if (!PIN_PATTERN.test(employeeForm.pin.trim())) {
      flash("PIN must be exactly 4 digits.");
      return;
    }
    if (
      state.employees.some(
        (employee) => employee.active && employee.id.toLowerCase() === employeeForm.id.trim().toLowerCase()
      )
    ) {
      flash("An active employee with this ID already exists.");
      return;
    }

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_create_employee", {
        admin_code_input: currentUser.id,
        admin_pin: session.pin,
        employee_code_input: employeeForm.id.trim(),
        full_name_input: employeeForm.name.trim(),
        employee_pin: employeeForm.pin.trim(),
      });

      if (error || !data) {
        flash("An active employee with this ID already exists, or details are invalid.");
        return;
      }

      await refreshRemoteState();
      setEmployeeForm({ id: "", name: "", pin: "" });
      flash("Employee login created.");
      return;
    }

    setState((current) => ({
      ...current,
      employees: [
        ...current.employees,
        {
          id: employeeForm.id.trim().toUpperCase(),
          name: employeeForm.name.trim(),
          role: "employee",
          pin: employeeForm.pin.trim(),
          active: true,
        },
      ],
    }));
    setEmployeeForm({ id: "", name: "", pin: "" });
    flash("Employee login created.");
  }

  async function adminResetPin(event) {
    event.preventDefault();

    if (!isAdmin) return;
    if (!EMPLOYEE_ID_PATTERN.test(adminPinForm.employeeId.trim())) {
      flash("Enter a valid employee ID.");
      return;
    }
    if (!PIN_PATTERN.test(adminPinForm.newPin)) {
      flash("New PIN must be exactly 4 digits.");
      return;
    }

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_admin_reset_pin", {
        admin_code_input: currentUser.id,
        admin_pin: session.pin,
        employee_code_input: adminPinForm.employeeId.trim(),
        new_pin: adminPinForm.newPin,
      });

      if (error || !data) {
        flash("Employee not found.");
        return;
      }

      setAdminPinForm({ employeeId: "", newPin: "" });
      flash("Employee PIN reset.");
      return;
    }

    const employee = state.employees.find(
      (item) =>
        item.id.trim().toLowerCase() === adminPinForm.employeeId.trim().toLowerCase() &&
        item.role === "employee" &&
        item.active
    );

    if (!employee) {
      flash("Employee not found.");
      return;
    }

    setState((current) => ({
      ...current,
      employees: current.employees.map((item) =>
        item.id === employee.id ? { ...item, pin: adminPinForm.newPin } : item
      ),
    }));
    setAdminPinForm({ employeeId: "", newPin: "" });
    flash(`PIN reset for ${employee.name}.`);
  }

  async function deleteEmployee() {
    if (!isAdmin || !deleteCandidate) return;

    if (USE_SUPABASE) {
      const { data, error } = await supabase.rpc("app_delete_employee", {
        admin_code_input: currentUser.id,
        admin_pin: session.pin,
        employee_code_input: deleteCandidate.id,
      });

      if (error || !data) {
        flash("Employee could not be deleted.");
        return;
      }

      await refreshRemoteState();
      flash(`${deleteCandidate.name} deleted.`);
      setDeleteCandidate(null);
      return;
    }

    setState((current) => ({
      ...current,
      employees: current.employees.map((employee) =>
        employee.id === deleteCandidate.id ? { ...employee, active: false } : employee
      ),
    }));
    flash(`${deleteCandidate.name} deleted.`);
    setDeleteCandidate(null);
  }

  function exportXlsx() {
    const detailedRows = state.recoveries
      .filter((entry) => getMonthFromDate(entry.date) === selectedMonth)
      .sort((a, b) => a.employeeId.localeCompare(b.employeeId) || b.date.localeCompare(a.date))
      .map((entry) => {
        const employee = state.employees.find((item) => item.id === entry.employeeId);
        const row = rows.find((item) => item.id === entry.employeeId);
        return [
          entry.employeeId,
          employee?.name || "",
          entry.date,
          Number(entry.amount),
          selectedMonth,
          row?.targetName || "Monthly target",
        ];
      });
    const workbook = createWorkbook([
      {
        name: "Summary",
        rows: [
          ["Employee ID", "Name", "Month", "Target Name", "Target", "Achieved", "Progress %"],
          ...rows.map((row) => [
            row.id,
            row.name,
            selectedMonth,
            row.targetName,
            row.target,
            row.recovered,
            Number(row.progress.toFixed(2)),
          ]),
        ],
      },
      {
        name: "Targets",
        rows: [["Employee ID", "Name", "Month", "Target Name", "Target"],
          ...rows.flatMap((row) => row.targets.map((target) => [row.id, row.name, selectedMonth, target.name, Number(target.amount)]))],
      },
      {
        name: "Detailed Entries",
        rows: [
          ["Employee ID", "Name", "Entry Date", "Entry Amount", "Month", "Target Name"],
          ...detailedRows,
        ],
      },
    ]);
    const blob = new Blob([workbook], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trackboard-${selectedMonth}.xlsx`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportCsv() {
    const header = ["Employee ID", "Name", "Month", "Target Name", "Target", "Achieved", "Progress %"];
    const body = rows.map((row) => [
      row.id,
      row.name,
      selectedMonth,
      row.targetName,
      row.target,
      row.recovered,
      row.progress.toFixed(2),
    ]);
    const csv = [header, ...body]
      .map((line) => line.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `trackboard-${selectedMonth}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading) {
    return (
      <main className="login-screen">
        <section className="login-panel" aria-label="Loading">
          <div className="brand-mark">
            <Landmark size={30} aria-hidden="true" />
          </div>
          <p className="eyebrow">Loading</p>
          <h1>{APP_NAME}</h1>
          <p className="login-copy">Connecting to your workspace.</p>
        </section>
      </main>
    );
  }

  if (!hasActiveAdmin && !currentUser) {
    return (
      <main className="login-screen">
        <section className="login-panel" aria-label="Admin setup">
          <div className="brand-mark">
            <Landmark size={30} aria-hidden="true" />
          </div>
          <p className="eyebrow">First setup</p>
          <h1>{APP_NAME}</h1>
          <p className="login-copy">Create the branch manager login to start using this workspace.</p>
          <form className="stack" onSubmit={setupAdmin}>
            <label>
              Admin ID
              <input
                value={setupForm.employeeId}
                onChange={(event) =>
                  setSetupForm((current) => ({
                    ...current,
                    employeeId: event.target.value.replace(/[^a-z0-9]/gi, ""),
                  }))
                }
                autoComplete="username"
                placeholder="ADMIN1"
              />
            </label>
            <label>
              Name
              <input
                value={setupForm.name}
                onChange={(event) =>
                  setSetupForm((current) => ({ ...current, name: event.target.value }))
                }
                placeholder="Branch Manager"
              />
            </label>
            <label>
              PIN
              <input
                value={setupForm.pin}
                onChange={(event) =>
                  setSetupForm((current) => ({
                    ...current,
                    pin: event.target.value.replace(/\D/g, "").slice(0, 4),
                  }))
                }
                type="password"
                inputMode="numeric"
                maxLength={4}
                autoComplete="new-password"
                placeholder="4 digit PIN"
              />
            </label>
            <button className="primary-button" type="submit">
              <Save size={18} aria-hidden="true" />
              Create admin
            </button>
          </form>
          {notice && <p className="notice">{notice}</p>}
        </section>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <main className="login-screen">
        <section className="login-panel" aria-label="Login">
          <div className="brand-mark">
            <Landmark size={30} aria-hidden="true" />
          </div>
          <p className="eyebrow">Branch target tracker</p>
          <h1>{APP_NAME}</h1>
          <p className="login-copy">A focused dashboard for monthly targets, daily entries, and team momentum.</p>
          <div className="auth-tabs" role="tablist" aria-label="Authentication options">
            <button
              className={authMode === "login" ? "active" : ""}
              type="button"
              onClick={() => setAuthMode("login")}
            >
              <UserRound size={16} aria-hidden="true" />
              Sign in
            </button>
            <button
              className={authMode === "reset" ? "active" : ""}
              type="button"
              onClick={() => setAuthMode("reset")}
            >
              <KeyRound size={16} aria-hidden="true" />
              Reset PIN
            </button>
          </div>

          {authMode === "login" ? (
            <form className="stack" onSubmit={login}>
              <label>
                Employee ID
                <input
                  value={loginForm.employeeId}
                  onChange={(event) =>
                    setLoginForm((current) => ({ ...current, employeeId: event.target.value }))
                  }
                  autoComplete="username"
                />
              </label>
              <label>
                PIN
                <input
                  value={loginForm.pin}
                  onChange={(event) =>
                    setLoginForm((current) => ({
                      ...current,
                      pin: event.target.value.replace(/\D/g, "").slice(0, 4),
                    }))
                  }
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="current-password"
                />
              </label>
              <button className="primary-button" type="submit">
                <UserRound size={18} aria-hidden="true" />
                Sign in
              </button>
            </form>
          ) : (
            <form className="stack" onSubmit={resetPin}>
              <label>
                Employee ID
                <input
                  value={resetForm.employeeId}
                  onChange={(event) =>
                    setResetForm((current) => ({
                      ...current,
                      employeeId: event.target.value.replace(/[^a-z0-9]/gi, ""),
                    }))
                  }
                  autoComplete="username"
                />
              </label>
              <label>
                Old PIN
                <input
                  value={resetForm.currentPin}
                  onChange={(event) =>
                    setResetForm((current) => ({
                      ...current,
                      currentPin: event.target.value.replace(/\D/g, "").slice(0, 4),
                    }))
                  }
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="current-password"
                />
              </label>
              <label>
                New PIN
                <input
                  value={resetForm.newPin}
                  onChange={(event) =>
                    setResetForm((current) => ({
                      ...current,
                      newPin: event.target.value.replace(/\D/g, "").slice(0, 4),
                    }))
                  }
                  type="password"
                  inputMode="numeric"
                  maxLength={4}
                  autoComplete="new-password"
                />
              </label>
              <button className="primary-button" type="submit">
                <KeyRound size={18} aria-hidden="true" />
                Reset PIN
              </button>
            </form>
          )}
          {notice && <p className="notice">{notice}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">{isAdmin ? "Manager view" : "Employee view"}</p>
          <h1>{APP_NAME}</h1>
        </div>
        <div className="top-actions">
          <span className="session-chip">{currentUser.name}</span>
          <button className="icon-button" type="button" onClick={() => setSession(null)} title="Sign out">
            <LogOut size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="toolbar" aria-label="Month controls">
        <label>
          Month
          <select value={selectedMonth} onChange={(event) => setSelectedMonth(event.target.value)}>
            {months.map((month) => (
              <option key={month} value={month}>
                {formatMonth(month)}
              </option>
            ))}
          </select>
        </label>
        {isAdmin && (
          <button className="secondary-button" type="button" onClick={exportXlsx}>
            <Download size={18} aria-hidden="true" />
            Export XLSX
          </button>
        )}
      </section>

      {notice && <p className="notice floating">{notice}</p>}

      {!isAdmin && (
        <section className="summary-grid" aria-label="Summary">
          <MetricCard icon={Target} label={summary.targetLabel} value={formatCurrency(summary.target)} />
          <MetricCard icon={Landmark} label={summary.recoveredLabel} value={formatCurrency(summary.recovered)} />
          <MetricCard icon={BarChart3} label={summary.progressLabel} value={`${summary.progress.toFixed(1)}%`} />
        </section>
      )}

      {isAdmin ? (
        <AdminView
          employeeForm={employeeForm}
          onEmployeeFormChange={setEmployeeForm}
          onAddEmployee={addEmployee}
          rows={rows}
          selectedMonth={selectedMonth}
          targetDrafts={targetDrafts}
          onTargetDraftChange={setTargetDrafts}
          onSaveTarget={saveTarget}
          onDeleteTarget={deleteTarget}
          adminPinForm={adminPinForm}
          onAdminPinFormChange={setAdminPinForm}
          onAdminResetPin={adminResetPin}
          onRequestDelete={setDeleteCandidate}
        />
      ) : (
        <EmployeeView
          currentUser={currentUser}
          ownRow={ownRow}
          rows={rows}
          entries={state.recoveries
            .filter((item) => item.employeeId === currentUser.id && getMonthFromDate(item.date) === selectedMonth)
            .sort((a, b) => b.date.localeCompare(a.date))}
          entryForm={entryForm}
          editingEntryId={editingEntryId}
          onEntryFormChange={setEntryForm}
          onAddRecovery={addRecovery}
          onStartEditEntry={startEditEntry}
          onCancelEditEntry={cancelEditEntry}
          onDeleteRecovery={deleteRecovery}
        />
      )}

      {deleteCandidate && (
        <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="delete-title">
          <section className="confirm-modal">
            <div className="danger-icon">
              <Trash2 size={22} aria-hidden="true" />
            </div>
            <h2 id="delete-title">Delete employee?</h2>
            <p>
              This will remove {deleteCandidate.name} from active logins and dashboards. Existing historical
              entries are kept for records.
            </p>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setDeleteCandidate(null)}>
                Cancel
              </button>
              <button className="danger-button" type="button" onClick={deleteEmployee}>
                <Trash2 size={18} aria-hidden="true" />
                Delete employee
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function MetricCard({ icon: Icon, label, value }) {
  return (
    <article className="metric-card">
      <div className="metric-icon">
        <Icon size={21} aria-hidden="true" />
      </div>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>
    </article>
  );
}

function AdminView({
  employeeForm,
  onEmployeeFormChange,
  onAddEmployee,
  rows,
  selectedMonth,
  targetDrafts,
  onTargetDraftChange,
  onSaveTarget,
  onDeleteTarget,
  adminPinForm,
  onAdminPinFormChange,
  onAdminResetPin,
  onRequestDelete,
}) {
  const [activeTab, setActiveTab] = useState("dashboard");

  return (
    <>
      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        <button
          className={activeTab === "dashboard" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("dashboard")}
        >
          <BarChart3 size={17} aria-hidden="true" />
          Dashboard
        </button>
        <button
          className={activeTab === "employees" ? "active" : ""}
          type="button"
          onClick={() => setActiveTab("employees")}
        >
          <UsersRound size={17} aria-hidden="true" />
          Employee Management
        </button>
      </div>

      {activeTab === "dashboard" ? (
        <AdminDashboard
          rows={rows}
          selectedMonth={selectedMonth}
          targetDrafts={targetDrafts}
          onTargetDraftChange={onTargetDraftChange}
          onSaveTarget={onSaveTarget}
          onDeleteTarget={onDeleteTarget}
        />
      ) : (
        <EmployeeManagement
          employeeForm={employeeForm}
          onEmployeeFormChange={onEmployeeFormChange}
          onAddEmployee={onAddEmployee}
          adminPinForm={adminPinForm}
          onAdminPinFormChange={onAdminPinFormChange}
          onAdminResetPin={onAdminResetPin}
          rows={rows}
          onRequestDelete={onRequestDelete}
        />
      )}
    </>
  );
}

function AdminDashboard({ rows, selectedMonth, targetDrafts, onTargetDraftChange, onSaveTarget, onDeleteTarget }) {
  return (
    <>
      <section className="overview-grid" aria-label="Graphical performance overview">
        <section className="chart-panel team-panel wide-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Admin dashboard</p>
              <h2>Employee target pie</h2>
            </div>
            <BarChart3 size={22} aria-hidden="true" />
          </div>
          <EmployeePieChart rows={rows} />
        </section>
      </section>

      <section className="dashboard-band">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Target planning</p>
            <h2>Set target names and amounts</h2>
            <p>Add multiple targets per employee. Edit names and amounts, then Save. Delete removes a target row. Monthly progress uses their combined amount.</p>
          </div>
        </div>
        <ProgressTable
          rows={rows}
          allowTargetEdit
          targetDrafts={targetDrafts}
          onTargetDraftChange={onTargetDraftChange}
          onSaveTarget={onSaveTarget}
          onDeleteTarget={onDeleteTarget}
        />
      </section>
    </>
  );
}

function EmployeeManagement({
  employeeForm,
  onEmployeeFormChange,
  onAddEmployee,
  adminPinForm,
  onAdminPinFormChange,
  onAdminResetPin,
  rows,
  onRequestDelete,
}) {
  return (
    <section className="split-layout">
      <div className="admin-forms">
        <form className="panel stack" onSubmit={onAddEmployee}>
          <div className="section-heading compact">
            <h2>Create employee login</h2>
            <UsersRound size={22} aria-hidden="true" />
          </div>
          <label>
            Employee ID
            <input
              value={employeeForm.id}
              onChange={(event) =>
                onEmployeeFormChange((current) => ({
                  ...current,
                  id: event.target.value.replace(/[^a-z0-9]/gi, ""),
                }))
              }
              placeholder="EMP105 or 105"
            />
          </label>
          <label>
            Name
            <input
              value={employeeForm.name}
              onChange={(event) =>
                onEmployeeFormChange((current) => ({ ...current, name: event.target.value }))
              }
              placeholder="Employee name"
            />
          </label>
          <label>
            PIN
            <input
              value={employeeForm.pin}
              onChange={(event) =>
                onEmployeeFormChange((current) => ({
                  ...current,
                  pin: event.target.value.replace(/\D/g, "").slice(0, 4),
                }))
              }
              inputMode="numeric"
              maxLength={4}
              placeholder="4 digit PIN"
            />
          </label>
          <button className="primary-button" type="submit">
            <Plus size={18} aria-hidden="true" />
            Add login
          </button>
        </form>

        <form className="panel stack" onSubmit={onAdminResetPin}>
          <div className="section-heading compact">
            <h2>Reset employee PIN</h2>
            <KeyRound size={22} aria-hidden="true" />
          </div>
          <label>
            Employee ID
            <input
              value={adminPinForm.employeeId}
              onChange={(event) =>
                onAdminPinFormChange((current) => ({
                  ...current,
                  employeeId: event.target.value.replace(/[^a-z0-9]/gi, ""),
                }))
              }
              placeholder="EMP101"
            />
          </label>
          <label>
            New PIN
            <input
              value={adminPinForm.newPin}
              onChange={(event) =>
                onAdminPinFormChange((current) => ({
                  ...current,
                  newPin: event.target.value.replace(/\D/g, "").slice(0, 4),
                }))
              }
              inputMode="numeric"
              maxLength={4}
              placeholder="4 digit PIN"
            />
          </label>
          <button className="secondary-button wide-button" type="submit">
            <KeyRound size={18} aria-hidden="true" />
            Reset employee PIN
          </button>
        </form>
      </div>

      <section className="panel">
        <div className="section-heading compact">
          <h2>Employees</h2>
          <UsersRound size={22} aria-hidden="true" />
        </div>
        <EmployeeDirectory rows={rows} onRequestDelete={onRequestDelete} />
      </section>
    </section>
  );
}

function TeamChart({ rows }) {
  const totalTarget = rows.reduce((sum, row) => sum + row.target, 0);
  const totalAmount = rows.reduce((sum, row) => sum + row.recovered, 0);
  const progress = totalTarget > 0 ? clampProgress((totalAmount / totalTarget) * 100) : 0;

  return (
    <div className="team-chart">
      <div className="donut" style={{ "--progress": `${Math.min(progress, 100) * 3.6}deg` }}>
        <span>{progress.toFixed(1)}%</span>
      </div>
      <div className="chart-stats">
        <span>
          <b>{formatCurrency(totalTarget)}</b>
          Team target
        </span>
        <span>
          <b>{formatCurrency(totalAmount)}</b>
          Team amount
        </span>
      </div>
    </div>
  );
}

function EmployeePieChart({ rows }) {
  const [activeId, setActiveId] = useState(rows[0]?.id || null);

  if (rows.length === 0) {
    return <p className="empty-state">No employees yet.</p>;
  }

  const colors = ["#7ee0c5", "#f2bf57", "#8ca5ff", "#ff8f70", "#b6e66a", "#d28cff", "#69c7ff", "#ff7ea8"];
  const totalTarget = rows.reduce((sum, row) => sum + row.target, 0);
  const fallbackShare = 100 / rows.length;
  const activeRow = rows.find((row) => row.id === activeId) || rows[0];
  const slices = buildPieSlices(rows, totalTarget, fallbackShare);

  return (
    <div className="employee-pie-layout">
      <figure className="employee-pie-card">
        <svg className="employee-pie-svg" viewBox="0 0 220 220" role="img" aria-label="Employee target share pie">
          {slices.map((slice, index) =>
            slice.fullCircle ? (
              <circle
                className={`pie-slice ${activeRow.id === slice.row.id ? "active" : ""}`}
                key={slice.row.id}
                cx="110"
                cy="110"
                r="96"
                fill={colors[index % colors.length]}
                onMouseEnter={() => setActiveId(slice.row.id)}
                onFocus={() => setActiveId(slice.row.id)}
                tabIndex="0"
              >
                <title>{pieTitle(slice.row)}</title>
              </circle>
            ) : (
              <path
                className={`pie-slice ${activeRow.id === slice.row.id ? "active" : ""}`}
                key={slice.row.id}
                d={slice.path}
                fill={colors[index % colors.length]}
                onMouseEnter={() => setActiveId(slice.row.id)}
                onFocus={() => setActiveId(slice.row.id)}
                tabIndex="0"
              >
                <title>{pieTitle(slice.row)}</title>
              </path>
            )
          )}
          <circle cx="110" cy="110" r="52" className="pie-hole" />
          <text x="110" y="102" textAnchor="middle" className="pie-center-main">
            {activeRow.progress.toFixed(1)}%
          </text>
          <text x="110" y="124" textAnchor="middle" className="pie-center-sub">
            achieved
          </text>
        </svg>
      </figure>
      <div className="pie-table-wrap" aria-label="Employee pie details">
        <div className="pie-focus-strip">
          <strong>{activeRow.name}</strong>
          <span>{activeRow.targetName}</span>
          <b>{formatCurrency(activeRow.target)} target</b>
          <b>{formatCurrency(activeRow.recovered)} achieved</b>
        </div>
        <table className="pie-table">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Target name</th>
              <th>Target</th>
              <th>Achieved</th>
              <th>Done</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr
                className={activeRow.id === row.id ? "active" : ""}
                key={row.id}
                onMouseEnter={() => setActiveId(row.id)}
              >
                <td>
                  <span className="pie-dot" style={{ background: colors[index % colors.length] }} />
                  <strong>{row.name}</strong>
                  <small>{row.id}</small>
                </td>
                <td>{row.targetName}</td>
                <td>{formatCurrency(row.target)}</td>
                <td>{formatCurrency(row.recovered)}</td>
                <td>{row.progress.toFixed(1)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function pieTitle(row) {
  return `${row.name} | ${row.targetName} | Target ${formatCurrency(row.target)} | Achieved ${formatCurrency(
    row.recovered
  )} | ${row.progress.toFixed(1)}% complete`;
}

function buildPieSlices(rows, totalTarget, fallbackShare) {
  let cursor = -90;
  return rows.map((row) => {
    const share = totalTarget > 0 ? (row.target / totalTarget) * 100 : fallbackShare;
    if (share >= 99.999) {
      return { row, fullCircle: true };
    }

    const startAngle = cursor;
    const endAngle = cursor + share * 3.6;
    cursor = endAngle;
    return {
      row,
      fullCircle: false,
      path: describePieSlice(110, 110, 96, startAngle, endAngle),
    };
  });
}

function describePieSlice(cx, cy, radius, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, radius, endAngle);
  const end = polarToCartesian(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`,
    "Z",
  ].join(" ");
}

function polarToCartesian(cx, cy, radius, angleInDegrees) {
  const angleInRadians = (angleInDegrees * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(angleInRadians),
    y: cy + radius * Math.sin(angleInRadians),
  };
}

function PerformanceBars({ rows }) {
  if (rows.length === 0) {
    return <p className="empty-state">No employees yet.</p>;
  }

  return (
    <div className="bar-list">
      {rows.map((row) => (
        <div className="bar-row" key={row.id}>
          <div>
            <strong>{row.name}</strong>
            <span>{row.targetName}</span>
          </div>
          <div className="bar-track">
            <div className="bar-fill" style={{ width: `${Math.min(row.progress, 100)}%` }} />
          </div>
          <b>{row.progress.toFixed(1)}%</b>
        </div>
      ))}
    </div>
  );
}

function EmployeeDirectory({ rows, onRequestDelete }) {
  if (rows.length === 0) {
    return <p className="empty-state">No employees yet.</p>;
  }

  return (
    <div className="employee-directory">
      {rows.map((row) => (
        <div className="employee-row" key={row.id}>
          <div>
            <strong>{row.name}</strong>
            <span>{row.id}</span>
          </div>
          <button className="mini-danger-button" type="button" onClick={() => onRequestDelete(row)}>
            <Trash2 size={16} aria-hidden="true" />
            Delete
          </button>
        </div>
      ))}
    </div>
  );
}

function EmployeeView({
  currentUser,
  ownRow,
  rows,
  entries,
  entryForm,
  editingEntryId,
  onEntryFormChange,
  onAddRecovery,
  onStartEditEntry,
  onCancelEditEntry,
  onDeleteRecovery,
}) {
  return (
    <>
      <section className="personal-band">
        <div>
          <p className="eyebrow">{currentUser.id}</p>
          <h2>{currentUser.name}</h2>
          <span className="personal-subline">{formatCurrency(ownRow?.recovered || 0)} logged this month</span>
        </div>
        <div className="hero-progress">
          <span>{ownRow?.progress.toFixed(1) || "0.0"}%</span>
          <ProgressBar value={ownRow?.progress || 0} />
        </div>
      </section>

      <section className="split-layout">
        <form className="panel stack" onSubmit={onAddRecovery}>
          <div className="section-heading compact">
            <h2>{editingEntryId ? "Edit entry" : "Add entry"}</h2>
            <CalendarDays size={22} aria-hidden="true" />
          </div>
          <label>
            Date
            <input
              type="date"
              value={entryForm.date}
              onChange={(event) =>
                onEntryFormChange((current) => ({ ...current, date: event.target.value }))
              }
            />
          </label>
          <label>
            Amount
            <input
              value={entryForm.amount}
              onChange={(event) =>
                onEntryFormChange((current) => ({
                  ...current,
                  amount: event.target.value.replace(/\D/g, ""),
                }))
              }
              inputMode="numeric"
              placeholder="100000"
            />
          </label>
          <div className="form-actions">
            <button className="primary-button" type="submit">
              <Save size={18} aria-hidden="true" />
              {editingEntryId ? "Update entry" : "Save entry"}
            </button>
            {editingEntryId && (
              <button className="secondary-button" type="button" onClick={onCancelEditEntry}>
                Cancel
              </button>
            )}
          </div>
        </form>

        <section className="panel">
          <div className="section-heading compact">
            <h2>Your entries</h2>
            <Landmark size={22} aria-hidden="true" />
          </div>
          <div className="entry-list">
            {entries.length === 0 ? (
              <p className="empty-state">No entries for this month.</p>
            ) : (
              entries.map((entry) => (
                <div className="entry-row" key={entry.id}>
                  <div>
                    <span>{new Date(entry.date).toLocaleDateString("en-IN")}</span>
                    <strong>{formatCurrency(entry.amount)}</strong>
                  </div>
                  <div className="row-actions">
                    <button className="mini-button" type="button" onClick={() => onStartEditEntry(entry)}>
                      <Pencil size={15} aria-hidden="true" />
                      Edit
                    </button>
                    <button className="mini-danger-button" type="button" onClick={() => onDeleteRecovery(entry.id)}>
                      <Trash2 size={15} aria-hidden="true" />
                      Delete
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </section>
      </section>

      <section className="dashboard-band">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Leaderboard</p>
            <h2>Team progress</h2>
          </div>
        </div>
        <ProgressTable rows={rows} />
      </section>
    </>
  );
}

function ProgressTable({
  rows,
  allowTargetEdit = false,
  targetDrafts = {},
  onTargetDraftChange,
  onSaveTarget,
  onDeleteTarget,
  onRequestDelete,
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Employee</th>
            <th>Target name</th>
            <th>Target</th>
            <th>Amount</th>
            <th>Progress</th>
            {allowTargetEdit && <th>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <strong>{row.name}</strong>
                <span>{row.id}</span>
              </td>
              {allowTargetEdit ? (
                <td colSpan={2}>
                  <div className="stack">
                    {(targetDrafts[row.id] || []).map((draft, index) => (
                      <div className="row-actions" key={draft.id}>
                        <input className="target-name-input" value={draft.name}
                          aria-label={`Target name for ${row.name}${index ? ` ${index + 1}` : ""}`}
                          placeholder="Loan Recovery"
                          onChange={(event) => onTargetDraftChange((current) => ({ ...current,
                            [row.id]: current[row.id].map((item) => item.id === draft.id ? { ...item, name: event.target.value } : item),
                          }))} />
                        <input className="table-input" value={draft.amount} inputMode="numeric"
                          aria-label={`Target for ${row.name}${index ? ` ${index + 1}` : ""}`}
                          onChange={(event) => onTargetDraftChange((current) => ({ ...current,
                            [row.id]: current[row.id].map((item) => item.id === draft.id ? { ...item, amount: event.target.value.replace(/\D/g, "") } : item),
                          }))} />
                        {row.targets.some((target) => target.id === draft.id) && (
                          <button className="mini-button" type="button"
                            onClick={(event) => event.currentTarget.parentElement.querySelector("input").focus()}>
                            <Pencil size={16} aria-hidden="true" />Edit
                          </button>
                        )}
                        <button className="mini-button" type="button" onClick={() => onSaveTarget(row.id, draft.id)}>
                          <Save size={16} aria-hidden="true" />Save
                        </button>
                        <button className="mini-danger-button" type="button"
                          aria-label={`Delete target ${index + 1} for ${row.name}`}
                          onClick={() => onDeleteTarget(row.id, draft.id)}>
                          <Trash2 size={16} aria-hidden="true" />Delete
                        </button>
                      </div>
                    ))}
                    <span>Total: {formatCurrency(row.target)}</span>
                  </div>
                </td>
              ) : (
                <><td><div className="stack">{row.targets.map((target) => (
                  <span className="target-name" key={target.id}>{target.name}: {formatCurrency(target.amount)}</span>
                ))}{!row.targets.length && "No targets assigned"}</div></td><td>{formatCurrency(row.target)}</td></>
              )}
              <td>{formatCurrency(row.recovered)}</td>
              <td>
                <div className="progress-cell">
                  <span>{row.progress.toFixed(1)}%</span>
                  <ProgressBar value={row.progress} />
                </div>
              </td>
              {allowTargetEdit && (
                <td>
                  <div className="row-actions">
                    <button className="mini-button" type="button" onClick={() => onTargetDraftChange((current) => ({
                      ...current, [row.id]: [...(current[row.id] || []), { id: crypto.randomUUID(), name: "", amount: "" }],
                    }))}>
                      <Plus size={16} aria-hidden="true" />Add target
                    </button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Leaderboard({ rows }) {
  if (rows.length === 0) {
    return <p className="empty-state">No employees yet.</p>;
  }

  return (
    <div className="leaderboard">
      {rows.map((row, index) => (
        <div className="leader-row" key={row.id}>
          <span className="rank">{index + 1}</span>
          <div>
            <strong>{row.name}</strong>
            <span>{formatCurrency(row.recovered)}</span>
          </div>
          <b>{row.progress.toFixed(1)}%</b>
        </div>
      ))}
    </div>
  );
}

function ProgressBar({ value }) {
  return (
    <div className="progress-track" aria-hidden="true">
      <div className="progress-fill" style={{ width: `${Math.min(value, 100)}%` }} />
    </div>
  );
}

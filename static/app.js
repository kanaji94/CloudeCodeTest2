const HISTORY_KEY = "quotationOcrHistory";

const ITEM_FIELDS = [
  "part_no", "part_name", "material", "drawing_no", "revision",
  "quantity", "unit", "unit_price", "amount", "delivery_date",
  "surface_treatment", "tolerance", "remarks",
];

const HEADER_FIELDS = [
  { key: "partner_name", label: "取引先名" },
  { key: "partner_contact", label: "担当者名" },
  { key: "document_number", label: "書類番号" },
  { key: "issue_date", label: "発行日" },
  { key: "due_date", label: "回答期限・希望納期" },
  { key: "validity_date", label: "見積有効期限" },
  { key: "payment_terms", label: "支払条件" },
  { key: "currency", label: "通貨" },
  { key: "remarks", label: "備考" },
];

const DOC_TYPE_LABELS = {
  rfq: "見積依頼書",
  customer_order: "客先注文書",
  supplier_quote: "仕入先見積書",
  drawing: "図面",
};

let selectedDocType = "rfq";
let selectedFiles = [];
let currentResult = null;

const docTypeTabs = document.getElementById("docTypeTabs");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const previewList = document.getElementById("previewList");
const extractBtn = document.getElementById("extractBtn");
const statusEl = document.getElementById("status");
const resultPanel = document.getElementById("resultPanel");
const notesBox = document.getElementById("notesBox");
const headerGrid = document.getElementById("headerGrid");
const itemsBody = document.getElementById("itemsBody");
const historyBody = document.getElementById("historyBody");

docTypeTabs.addEventListener("click", (e) => {
  const btn = e.target.closest(".doc-type-btn");
  if (!btn) return;
  selectedDocType = btn.dataset.value;
  [...docTypeTabs.children].forEach((c) => c.classList.toggle("active", c === btn));
});

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  setFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", () => setFiles(fileInput.files));

function setFiles(fileList) {
  selectedFiles = Array.from(fileList);
  previewList.innerHTML = "";
  selectedFiles.forEach((file) => {
    if (file.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      previewList.appendChild(img);
    } else {
      const chip = document.createElement("div");
      chip.className = "file-chip";
      chip.textContent = file.name;
      previewList.appendChild(chip);
    }
  });
  extractBtn.disabled = selectedFiles.length === 0;
}

extractBtn.addEventListener("click", async () => {
  if (selectedFiles.length === 0) return;
  extractBtn.disabled = true;
  setStatus("読み取り中です…（書類の枚数によっては数十秒かかります）", false);
  resultPanel.hidden = true;

  const formData = new FormData();
  formData.append("doc_type", selectedDocType);
  selectedFiles.forEach((f) => formData.append("file", f));

  try {
    const res = await fetch("/api/extract", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok) {
      setStatus(data.error || "読み取りに失敗しました。", true);
      return;
    }
    currentResult = data;
    renderResult(data);
    setStatus("読み取りが完了しました。内容を確認してください。", false);
  } catch (err) {
    setStatus("通信エラーが発生しました: " + err.message, true);
  } finally {
    extractBtn.disabled = false;
  }
});

function setStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (isError ? " error" : "");
}

function renderResult(data) {
  resultPanel.hidden = false;

  if (data.overall_notes) {
    notesBox.hidden = false;
    notesBox.textContent = "読み取りメモ: " + data.overall_notes;
  } else {
    notesBox.hidden = true;
  }

  headerGrid.innerHTML = "";
  HEADER_FIELDS.forEach(({ key, label }) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const labelEl = document.createElement("label");
    labelEl.textContent = label;
    const input = document.createElement("input");
    input.value = (data.header && data.header[key]) || "";
    input.dataset.headerKey = key;
    wrap.appendChild(labelEl);
    wrap.appendChild(input);
    headerGrid.appendChild(wrap);
  });

  itemsBody.innerHTML = "";
  const items = Array.isArray(data.items) && data.items.length > 0 ? data.items : [emptyItem()];
  items.forEach((item) => addItemRow(item));
}

function emptyItem() {
  const item = {};
  ITEM_FIELDS.forEach((f) => (item[f] = ""));
  return item;
}

function addItemRow(item) {
  const tr = document.createElement("tr");
  ITEM_FIELDS.forEach((field) => {
    const td = document.createElement("td");
    const input = document.createElement("input");
    input.value = item[field] || "";
    input.dataset.itemField = field;
    td.appendChild(input);
    tr.appendChild(td);
  });
  const actionTd = document.createElement("td");
  const delBtn = document.createElement("button");
  delBtn.textContent = "削除";
  delBtn.type = "button";
  delBtn.className = "row-delete-btn";
  delBtn.addEventListener("click", () => tr.remove());
  actionTd.appendChild(delBtn);
  tr.appendChild(actionTd);
  itemsBody.appendChild(tr);
}

document.getElementById("addRowBtn").addEventListener("click", () => addItemRow(emptyItem()));

function collectFormResult() {
  const header = {};
  headerGrid.querySelectorAll("input[data-header-key]").forEach((input) => {
    header[input.dataset.headerKey] = input.value;
  });

  const items = [];
  itemsBody.querySelectorAll("tr").forEach((tr) => {
    const item = {};
    tr.querySelectorAll("input[data-item-field]").forEach((input) => {
      item[input.dataset.itemField] = input.value;
    });
    items.push(item);
  });

  return {
    doc_type: currentResult?.doc_type || selectedDocType,
    source_filename: currentResult?.source_filename || "",
    overall_notes: currentResult?.overall_notes || "",
    header,
    items,
  };
}

function csvEscape(value) {
  const str = String(value ?? "");
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function recordsToCsv(records) {
  const headerCols = ["保存日時", "書類種別", ...HEADER_FIELDS.map((h) => h.label), "ファイル名", ...ITEM_FIELDS];
  const rows = [headerCols];

  records.forEach((rec) => {
    const baseCols = [
      rec.savedAt || "",
      DOC_TYPE_LABELS[rec.doc_type] || rec.doc_type,
      ...HEADER_FIELDS.map((h) => rec.header?.[h.key] || ""),
      rec.source_filename || "",
    ];
    const items = rec.items && rec.items.length > 0 ? rec.items : [emptyItem()];
    items.forEach((item) => {
      rows.push([...baseCols, ...ITEM_FIELDS.map((f) => item[f] || "")]);
    });
  });

  return rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

function downloadCsv(csvContent, filename) {
  const blob = new Blob(["﻿" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

document.getElementById("downloadCsvBtn").addEventListener("click", () => {
  const record = { ...collectFormResult(), savedAt: new Date().toLocaleString("ja-JP") };
  downloadCsv(recordsToCsv([record]), `document_${Date.now()}.csv`);
});

document.getElementById("saveBtn").addEventListener("click", () => {
  const record = { ...collectFormResult(), savedAt: new Date().toLocaleString("ja-JP") };
  const history = loadHistory();
  history.unshift(record);
  saveHistory(history);
  renderHistory();
  setStatus("履歴に保存しました。", false);
});

document.getElementById("downloadAllCsvBtn").addEventListener("click", () => {
  const history = loadHistory();
  if (history.length === 0) {
    setStatus("履歴がありません。", true);
    return;
  }
  downloadCsv(recordsToCsv(history), `quotation_history_${Date.now()}.csv`);
});

document.getElementById("clearHistoryBtn").addEventListener("click", () => {
  if (!confirm("履歴を全て削除します。よろしいですか？")) return;
  saveHistory([]);
  renderHistory();
});

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
}

function renderHistory() {
  const history = loadHistory();
  historyBody.innerHTML = "";
  history.forEach((rec, idx) => {
    const tr = document.createElement("tr");
    const cells = [
      rec.savedAt || "",
      DOC_TYPE_LABELS[rec.doc_type] || rec.doc_type,
      rec.header?.partner_name || "",
      rec.header?.document_number || "",
      String(rec.items?.length || 0),
      rec.source_filename || "",
    ];
    cells.forEach((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    });
    const actionTd = document.createElement("td");
    const delBtn = document.createElement("button");
    delBtn.textContent = "削除";
    delBtn.type = "button";
    delBtn.className = "row-delete-btn";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const h = loadHistory();
      h.splice(idx, 1);
      saveHistory(h);
      renderHistory();
    });
    actionTd.appendChild(delBtn);
    tr.appendChild(actionTd);

    tr.addEventListener("click", () => {
      currentResult = rec;
      selectedDocType = rec.doc_type;
      [...docTypeTabs.children].forEach((c) => c.classList.toggle("active", c.dataset.value === rec.doc_type));
      renderResult(rec);
      window.scrollTo({ top: resultPanel.offsetTop - 20, behavior: "smooth" });
    });

    historyBody.appendChild(tr);
  });
}

renderHistory();

import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * DespensaApp – Versión Final (Producción)
 * -----------------------------------------
 * ✔ Diseño visual completo (V3).
 * ✔ Funcionalidades avanzadas (Arqueo, Reabrir Caja, CSV, Edición).
 * ✔ FIX: Condición de carrera solucionada (Pantalla de carga segura).
 */

// ---- Utilidades ----
const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
console.log("API_URL EN RUNTIME:", API_URL);

const currency = (n) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
  }).format(Number.isFinite(+n) ? +n : 0);

const uid = () => Math.random().toString(36).slice(2, 10);

const pedidosYaPrice = (precio) => {
  const base = Number(precio) || 0;
  if (base <= 0) return 0;
  return Math.ceil(base / (1 - 0.295));
};

const rappiPrice = (precio) => {
  const base = Number(precio) || 0;
  if (base <= 0) return 0;
  return Math.ceil(base / (1 - 0.2));
};

const parseMoneyInput = (v) => {
  const n = parseFloat(String(v || "").replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
};

function download(filename, text) {
  const blob = new Blob(["\uFEFF" + text], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function parseCSV(raw) {
  const sep = raw.includes(";") && !raw.includes(",") ? ";" : ",";
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const iEAN = header.indexOf("ean");
  const iNombre = header.indexOf("nombre");
  const iPrecio = header.indexOf("precio");
  if (iEAN === -1 || iNombre === -1 || iPrecio === -1) {
    throw new Error(
      "CSV inválido. Debe incluir columnas: ean,nombre,precio (separadas por coma o punto y coma)."
    );
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(sep).map((c) => c.trim());
    if (!cols[iEAN]) continue;
    const ean = cols[iEAN];
    const nombre = cols[iNombre] || "(sin nombre)";
    const precio = parseFloat(
      (cols[iPrecio] || "0").replace(/\./g, "").replace(",", ".")
    );
    if (!isFinite(precio)) continue;
    out.push({ id: uid(), ean, nombre, precio: +precio });
  }
  return out;
}

// ---- Fiados: cálculo de saldo ----
function computeSaldoPersona(fiador, productos) {
  const map = new Map((productos || []).map((p) => [p.ean, p]));
  let totalCargos = 0;

  for (const cargo of fiador.cargos || []) {
    for (const item of cargo.items || []) {
      const prod = map.get(item.ean);
      const qty = Number(item.qty) || 0;
      const precioBase =
        typeof item.precioUnitario === "number"
          ? item.precioUnitario
          : prod
          ? Number(prod.precio) || 0
          : 0;
      totalCargos += precioBase * qty;
    }
  }
  const totalAbonos = (fiador.abonos || []).reduce(
    (a, b) => a + (b.monto || 0),
    0
  );
  return totalCargos - totalAbonos;
}

// ---- Almacenamiento por usuario (CON FIX DE CARGA) ----
function useUserStorage(email) {
  const [state, setState] = useState({
    productos: [],
    ventas: [],
    gastos: [],
    proveedores: [],
    cierres: {},
    fiados: [],
    settings: {},
  });

  // Bandera de seguridad para evitar sobrescritura
  const [isLoaded, setIsLoaded] = useState(false);

  // 1. Carga inicial
  useEffect(() => {
    if (!email) return;
    setIsLoaded(false); // Bloquear guardado
    const controller = new AbortController();

    async function fetchState() {
      try {
        const res = await fetch(
          `${API_URL}/estado?email=${encodeURIComponent(email)}`,
          { signal: controller.signal }
        );
        if (!res.ok) throw new Error("Error al cargar estado");
        const data = await res.json();
        setState({
          productos: [],
          ventas: [],
          gastos: [],
          proveedores: [],
          cierres: {},
          fiados: [],
          settings: {},
          ...(data || {}),
        });
        setIsLoaded(true); // Habilitar guardado
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("Error cargando estado:", err);
        // Si falla la red gravemente, no habilitamos isLoaded para proteger datos locales vacíos.
        // Si es un 404 (usuario nuevo), el backend debería devolver JSON vacío y entrar al try.
        if (err.message !== "Error al cargar estado") {
           // Error de conexión, no hacemos nada (se queda cargando o muestra error)
        } else {
           // Si el backend responde error explícito, asumimos vacío seguro
           setIsLoaded(true);
        }
      }
    }
    fetchState();
    return () => controller.abort();
  }, [email]);

  // 2. Guardado automático
  useEffect(() => {
    if (!email) return;
    if (!isLoaded) return; // SI NO ESTÁ CARGADO, NO GUARDAR

    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        await fetch(
          `${API_URL}/estado?email=${encodeURIComponent(email)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(state),
            signal: controller.signal,
          }
        );
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("Error guardando estado:", err);
      }
    }, 1000); // Debounce de 1s
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [email, state, isLoaded]);

  return [state, setState, isLoaded];
}

// ---- Componentes de layout (Estilo Original) ----
function Section({ title, desc, children, right }) {
  return (
    <div className="bg-white/70 backdrop-blur shadow-sm rounded-2xl p-5 border border-gray-200">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
          {desc && <p className="text-sm text-gray-500">{desc}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function TopBar({ email, onLogout }) {
  return (
    <header className="flex items-center justify-between px-4 py-3 bg-white/80 backdrop-blur border-b border-gray-200 sticky top-0 z-30">
      <div className="flex items-center gap-3">
        <span className="text-2xl">🧺</span>
        <h1 className="text-lg font-semibold">DespensaApp</h1>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <span className="text-gray-600">{email}</span>
        <button
          onClick={onLogout}
          className="px-3 py-1.5 rounded-xl border text-gray-700 hover:bg-gray-50"
        >
          Cerrar sesión
        </button>
      </div>
    </header>
  );
}

function Login({ onLogin }) {
  const [email, setEmail] = useState("");
  const handle = (e) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert("Ingresa un email válido");
      return;
    }
    onLogin(email.toLowerCase());
  };
  return (
    <div className="min-h-[60vh] grid place-items-center">
      <form
        onSubmit={handle}
        className="bg-white/80 backdrop-blur border border-gray-200 rounded-2xl p-6 w-full max-w-md shadow-sm"
      >
        <h1 className="text-2xl font-semibold mb-2">Ingresar</h1>
        <p className="text-sm text-gray-600 mb-4">
          Por ahora solo pedimos tu email (MVP).
        </p>
        <label className="block text-sm text-gray-700 mb-1">Email</label>
        <input
          autoFocus
          className="w-full border rounded-xl px-3 py-2 mb-4 focus:outline-none focus:ring focus:ring-indigo-200"
          placeholder="tucorreo@ejemplo.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
        />
        <button className="w-full bg-indigo-600 text-white rounded-xl py-2 hover:bg-indigo-700">
          Entrar
        </button>
      </form>
    </div>
  );
}

// ---- Componente: Asistente de Arqueo (Modal) ----
function ArqueoCaja({ onClose, onConfirm }) {
  const billetes = [20000, 10000, 2000, 1000, 500, 200, 100, 50, 20, 10];
  const [counts, setCounts] = useState({});

  const total = useMemo(() => {
    return billetes.reduce((acc, b) => acc + b * (counts[b] || 0), 0);
  }, [counts]);

  const handleChange = (billete, val) => {
    const qty = parseInt(val || "0", 10);
    setCounts((prev) => ({ ...prev, [billete]: qty }));
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 grid place-items-center p-4 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh] border border-gray-200">
        <div className="p-4 border-b flex justify-between items-center bg-indigo-50">
          <h3 className="font-semibold text-indigo-900 flex items-center gap-2">
            <span>🧮</span> Asistente de Arqueo
          </h3>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 w-8 h-8 flex items-center justify-center rounded-full hover:bg-indigo-100"
          >
            ✕
          </button>
        </div>
        <div className="p-4 overflow-y-auto flex-1">
          <p className="text-sm text-gray-500 mb-4">
            Ingresa la cantidad de billetes contados:
          </p>
          <div className="space-y-2">
            {billetes.map((b) => (
              <div key={b} className="flex items-center gap-3">
                <div className="w-24 text-right font-medium text-gray-700">
                  ${b}
                </div>
                <span className="text-gray-400 text-xs">x</span>
                <input
                  type="number"
                  min="0"
                  className="flex-1 border rounded-lg px-3 py-1.5 text-right focus:ring-2 focus:ring-indigo-200 outline-none"
                  placeholder="0"
                  value={counts[b] || ""}
                  onChange={(e) => handleChange(b, e.target.value)}
                />
                <div className="w-24 text-right text-gray-900 font-mono">
                  {currency(b * (counts[b] || 0))}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="p-4 border-t bg-gray-50">
          <div className="flex justify-between items-center mb-4">
            <span className="text-lg font-bold text-gray-700">
              Total contado:
            </span>
            <span className="text-2xl font-bold text-indigo-600">
              {currency(total)}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={onClose}
              className="py-2 border rounded-xl hover:bg-gray-100 text-gray-700 font-medium"
            >
              Cancelar
            </button>
            <button
              onClick={() => onConfirm(total)}
              className="py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 font-medium shadow-sm"
            >
              Usar Total
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Componentes de Edición Inline ----
function InlineText({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(value);

  useEffect(() => setVal(value), [value]);

  const commit = () => {
    if (val.trim() !== "") {
      onChange(val.trim());
    } else {
      setVal(value);
    }
    setEditing(false);
  };

  if (!editing) {
    return (
      <div
        onClick={() => setEditing(true)}
        className="cursor-pointer hover:bg-gray-100 px-2 py-1 rounded border border-transparent hover:border-gray-300 truncate transition-colors"
        title="Clic para editar nombre"
      >
        {value}
      </div>
    );
  }

  return (
    <input
      autoFocus
      className="w-full border rounded px-2 py-1 text-sm focus:ring-2 focus:ring-indigo-200 outline-none"
      value={val}
      onChange={(e) => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function InlineMoney({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value));
  useEffect(() => setVal(String(value)), [value]);
  const commit = () => {
    const num = parseFloat(val.replace(/\./g, "").replace(",", "."));
    if (!isFinite(num)) return alert("Valor inválido");
    onChange(+num);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="px-2 py-1 rounded-lg hover:bg-gray-100 font-medium text-gray-900"
      >
        {currency(value)}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <input
        autoFocus
        className="w-28 border rounded-lg px-2 py-1 text-right focus:ring-2 focus:ring-indigo-200 outline-none"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <button
        onClick={commit}
        className="text-indigo-600 hover:underline text-xs font-semibold"
      >
        OK
      </button>
    </span>
  );
}

// ---- Productos ----
function Productos({ data, setData }) {
  const [q, setQ] = useState("");
  const [selectedIds, setSelectedIds] = useState([]);

  const results = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return data.productos;
    return data.productos.filter(
      (p) =>
        String(p.ean).toLowerCase().includes(term) ||
        p.nombre.toLowerCase().includes(term)
    );
  }, [q, data.productos]);

  const updatePrecio = (id, precio) => {
    setData((s) => ({
      ...s,
      productos: s.productos.map((p) => (p.id === id ? { ...p, precio } : p)),
    }));
  };

  const updateNombre = (id, nombre) => {
    setData((s) => ({
      ...s,
      productos: s.productos.map((p) => (p.id === id ? { ...p, nombre } : p)),
    }));
  };

  const remove = (id) => {
    if (!confirm("¿Eliminar este producto?")) return;
    setData((s) => ({
      ...s,
      productos: s.productos.filter((p) => p.id !== id),
    }));
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  };

  const removeSelected = () => {
    if (!selectedIds.length) return;
    if (
      !confirm(
        `¿Eliminar ${selectedIds.length} producto(s) seleccionados? Esta acción no se puede deshacer.`
      )
    )
      return;
    setData((s) => ({
      ...s,
      productos: s.productos.filter((p) => !selectedIds.includes(p.id)),
    }));
    setSelectedIds([]);
  };

  const addManual = () => {
    const ean = (prompt("EAN del artículo") || "").trim();
    if (!ean) return;
    if (data.productos.some((p) => String(p.ean) === ean)) {
      alert("Ya existe un producto con ese EAN. No se agregará.");
      return;
    }
    const nombre = prompt("Nombre del artículo") || "(sin nombre)";
    const precio = parseFloat(prompt("Precio ARS") || "0");
    if (!isFinite(precio)) return alert("Precio inválido");
    setData((s) => ({
      ...s,
      productos: [...s.productos, { id: uid(), ean, nombre, precio: +precio }],
    }));
  };

  const toggleSelect = (id) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const allVisibleSelected =
    results.length > 0 && results.every((p) => selectedIds.includes(p.id));

  const toggleSelectVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) =>
        prev.filter((id) => !results.some((p) => p.id === id))
      );
    } else {
      setSelectedIds((prev) => {
        const set = new Set(prev);
        results.forEach((p) => set.add(p.id));
        return Array.from(set);
      });
    }
  };

  const downloadList = () => {
    if (!data.productos.length) return alert("No hay productos para descargar.");
    const header = "ean,nombre,precio\n";
    const rows = data.productos
      .map((p) => `${p.ean},${p.nombre},${p.precio}`)
      .join("\n");
    download(
      `lista-productos-${new Date().toISOString().slice(0, 10)}.csv`,
      header + rows
    );
  };

  const generateLabels = () => {
    const selected = data.productos.filter((p) => selectedIds.includes(p.id));
    if (!selected.length) {
      alert("Selecciona al menos un producto para generar etiquetas.");
      return;
    }
    const w = window.open("", "_blank");
    if (!w)
      return alert(
        "No se pudo abrir la ventana. Revisa el bloqueador de popups."
      );
    const labelsHtml = selected
      .map((p) => {
        const priceText = currency(p.precio);
        return `
          <div class="label">
            <div class="label-name">${escapeHtml(p.nombre)}</div>
            <div class="label-price">${priceText}</div>
            <div class="label-ean">EAN: ${escapeHtml(p.ean)}</div>
          </div>
        `;
      })
      .join("");
    const html = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Etiquetas</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 16px; font-family: sans-serif; }
          .labels { display: flex; flex-wrap: wrap; gap: 12px; }
          .label {
            width: 180px; height: 110px; border: 2px solid #111827;
            border-radius: 10px; padding: 8px 10px;
            display: flex; flex-direction: column; justify-content: space-between;
          }
          .label-name { font-size: 12px; font-weight: 600; color: #111827; }
          .label-price { font-size: 26px; font-weight: 800; text-align: center; color: #111827; }
          .label-ean { font-size: 10px; color: #4b5563; text-align: right; }
          @page { margin: 10mm; }
        </style>
      </head>
      <body onload="window.print()">
        <div class="labels">${labelsHtml}</div>
      </body>
      </html>
    `;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <Section
      title="Productos"
      desc="Busca por código o nombre. Haz clic en el nombre o precio para editarlos."
      right={
        <div className="flex gap-2">
          <button
            onClick={addManual}
            className="px-3 py-1.5 rounded-xl border hover:bg-gray-50 transition-colors"
          >
            + Agregar
          </button>
          <button
            onClick={downloadList}
            className="px-3 py-1.5 rounded-xl border hover:bg-gray-50 transition-colors"
            title="Descargar lista completa en CSV"
          >
            ⬇ Lista (CSV)
          </button>
          <button
            onClick={generateLabels}
            className="px-3 py-1.5 rounded-xl border border-indigo-400 text-indigo-700 bg-indigo-50 hover:bg-indigo-100 text-sm transition-colors"
          >
            Etiquetas (PDF)
          </button>
          <button
            onClick={removeSelected}
            disabled={!selectedIds.length}
            className={
              "px-3 py-1.5 rounded-xl border text-sm transition-colors " +
              (selectedIds.length
                ? "border-red-400 text-red-700 bg-red-50 hover:bg-red-100"
                : "border-gray-200 text-gray-400 bg-gray-100 cursor-not-allowed")
            }
          >
            Eliminar
          </button>
        </div>
      }
    >
      <div className="flex items-center gap-3 mb-3">
        <input
          placeholder="Buscar por código o nombre..."
          className="flex-1 border rounded-xl px-3 py-2 focus:ring-2 focus:ring-indigo-200 outline-none"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="text-sm text-gray-500">
          {results.length} / {data.productos.length}
        </span>
      </div>
      <div className="overflow-auto max-h-[50vh] border rounded-2xl">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="p-2 text-center w-10">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectVisible}
                />
              </th>
              <th className="text-left p-2">EAN</th>
              <th className="text-left p-2">Nombre</th>
              <th className="text-right p-2">Precio</th>
              <th className="text-right p-2">PedidosYa</th>
              <th className="text-right p-2">Rappi</th>
              <th className="text-right p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {results.map((p) => (
              <tr key={p.id} className="odd:bg-white even:bg-gray-50">
                <td className="p-2 text-center">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(p.id)}
                    onChange={() => toggleSelect(p.id)}
                  />
                </td>
                <td className="p-2 font-mono">{p.ean}</td>
                <td className="p-2">
                  <InlineText
                    value={p.nombre}
                    onChange={(n) => updateNombre(p.id, n)}
                  />
                </td>
                <td className="p-2 text-right">
                  <InlineMoney
                    value={p.precio}
                    onChange={(v) => updatePrecio(p.id, v)}
                  />
                </td>
                <td className="p-2 text-right">
                  {currency(pedidosYaPrice(p.precio))}
                </td>
                <td className="p-2 text-right">
                  {currency(rappiPrice(p.precio))}
                </td>
                <td className="p-2 text-right">
                  <button
                    onClick={() => remove(p.id)}
                    className="text-red-600 hover:underline"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Importar / Exportar ----
function ImportExport({ data, setData }) {
  const fileRef = useRef(null);

  const handleImport = async (file) => {
    const text = await file.text();
    try {
      const rows = parseCSV(text);
      if (!rows.length) return alert("No se detectaron filas válidas.");
      setData((s) => {
        const byEAN = new Map(s.productos.map((p) => [p.ean, p]));
        rows.forEach((r) => {
          const ex = byEAN.get(r.ean);
          if (ex) {
            ex.nombre = r.nombre || ex.nombre;
            ex.precio = r.precio;
          } else {
            byEAN.set(r.ean, { ...r, id: uid() });
          }
        });
        return { ...s, productos: Array.from(byEAN.values()) };
      });
      alert(`Importados ${rows.length} productos.`);
    } catch (err) {
      alert(err.message || String(err));
    }
  };

  const exportJSON = () => {
    download(
      `respaldo-despensa-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(data, null, 2)
    );
  };

  const downloadTemplate = () => {
    const csv = [
      "ean,nombre,precio",
      "7790001000012,Leche entera 1L,1899",
      "7790001000029,Arroz 1kg,2150",
    ].join("\n");
    download("plantilla-productos.csv", csv);
  };

  return (
    <Section
      title="Importar / Exportar"
      desc="Carga productos desde CSV o descarga respaldo JSON."
      right={
        <button
          onClick={downloadTemplate}
          className="px-3 py-1.5 rounded-xl border hover:bg-gray-50"
        >
          ↓ Plantilla CSV
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            ref={fileRef}
            className="hidden"
            onChange={(e) =>
              e.target.files?.[0] && handleImport(e.target.files[0])
            }
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="px-3 py-2 rounded-xl border hover:bg-gray-50"
          >
            Importar CSV
          </button>
          <button
            onClick={exportJSON}
            className="px-3 py-2 rounded-xl border hover:bg-gray-50"
          >
            Exportar respaldo (JSON)
          </button>
        </div>
        <p className="text-sm text-gray-600">
          Formato esperado: <code>ean,nombre,precio</code>.
        </p>
      </div>
    </Section>
  );
}

// ---- Nueva venta (incluye Fiado) ----
function NuevaVenta({ data, setData }) {
  const [codigo, setCodigo] = useState("");
  const [items, setItems] = useState([]);
  const [metodo, setMetodo] = useState("efectivo");

  const addByCode = () => {
    const code = codigo.trim();
    if (!code) return;
    const codeNorm = code.toLowerCase();
    const prod = data.productos.find(
      (x) => String(x.ean).toLowerCase() === codeNorm
    );
    if (!prod) {
      alert("Código no encontrado en productos");
      return;
    }

    let precio = prod.precio;
    if (!precio || +precio === 0) {
      let manual = null;
      while (manual === null) {
        const input = prompt(
          `El producto "${prod.nombre}" tiene precio 0.\nIngresa el precio:`,
          ""
        );
        if (input === null) return;
        const cleaned = input.replace(/[^\d.,]/g, "");
        const digits = cleaned.replace(/\D/g, "");
        if (!digits || digits.length > 10) {
          alert("Precio inválido (máx 10 dígitos).");
          continue;
        }
        const num = parseFloat(cleaned.replace(/\./g, "").replace(",", "."));
        if (!isFinite(num) || num < 0) {
          alert("Ingresa un precio válido (>= 0).");
          continue;
        }
        manual = num;
      }
      precio = manual;
    }

    setItems((arr) => {
      const ex = arr.find((i) => i.ean === prod.ean && i.precio === precio);
      if (ex) {
        return arr.map((i) =>
          i.ean === prod.ean && i.precio === precio
            ? { ...i, qty: i.qty + 1 }
            : i
        );
      }
      return [
        ...arr,
        {
          id: uid(),
          ean: prod.ean,
          nombre: prod.nombre,
          precio,
          qty: 1,
        },
      ];
    });
    setCodigo("");
  };

  const total = useMemo(
    () => items.reduce((acc, i) => acc + i.precio * i.qty, 0),
    [items]
  );

  const setQty = (id, qty) => {
    setItems((arr) =>
      arr.map((i) => (i.id === id ? { ...i, qty: Math.max(1, qty) } : i))
    );
  };

  const remove = (id) => setItems((arr) => arr.filter((i) => i.id !== id));

  const finalizar = () => {
    if (!items.length) return alert("Agrega artículos a la venta.");
    for (const it of items) {
      if (!isFinite(+it.precio) || +it.precio < 0) {
        return alert("Revisa los precios ingresados.");
      }
    }

    const ahora = new Date().toISOString();
    const todayISO = new Date().toISOString().slice(0, 10);

    // IMPORTANTE: Determinar la "Fecha de Caja" (Logical Date)
    const fechaCaja = data.settings?.fechaCajaAbierta || todayISO;

    if (metodo === "fiado") {
      const nombre = (prompt("¿A nombre de quién?") || "").trim();
      if (!nombre) return alert("Falta el nombre.");

      const cargoItems = items.map((i) => {
        const prod = data.productos.find((p) => p.ean === i.ean);
        const prodPrecio = prod ? Number(prod.precio) || 0 : 0;
        if (prodPrecio === 0) {
          return { ean: i.ean, qty: i.qty, precioUnitario: i.precio };
        }
        return { ean: i.ean, qty: i.qty };
      });

      const cargo = { id: uid(), fecha: ahora, items: cargoItems };

      setData((s) => {
        const fiados = [...(s.fiados || [])];
        let persona = fiados.find(
          (f) => f.nombre.toLowerCase() === nombre.toLowerCase()
        );
        if (!persona) {
          persona = { id: uid(), nombre, cargos: [], abonos: [] };
          fiados.push(persona);
        }
        persona.cargos = [cargo, ...(persona.cargos || [])];
        return { ...s, fiados };
      });

      setItems([]);
      alert(`Venta fiada registrada a nombre de: ${nombre}`);
      return;
    }

    // Venta normal
    const venta = {
      id: uid(),
      fecha: ahora,
      fechaCaja, // Guardamos la fecha lógica de la caja
      items,
      metodo,
      total,
    };
    setData((s) => ({ ...s, ventas: [venta, ...s.ventas] }));
    setItems([]);
    alert("Venta registrada ✅");
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="md:col-span-2">
        <Section
          title="Nueva venta"
          desc="Escanea o ingresa el código EAN del artículo."
        >
          <div className="flex items-center gap-2 mb-3">
            <input
              placeholder="Código EAN o palabra"
              className="flex-1 border rounded-xl px-3 py-2 font-mono focus:ring-2 focus:ring-indigo-200 outline-none"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addByCode()}
            />
            <button
              onClick={addByCode}
              className="px-3 py-2 rounded-xl border hover:bg-gray-50"
            >
              Agregar
            </button>
          </div>
          <div className="overflow-auto max-h-[40vh] border rounded-2xl">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-left p-2">EAN</th>
                  <th className="text-left p-2">Artículo</th>
                  <th className="text-right p-2">Precio</th>
                  <th className="text-right p-2">Cant.</th>
                  <th className="text-right p-2">Subtotal</th>
                  <th className="text-right p-2">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id} className="odd:bg-white even:bg-gray-50">
                    <td className="p-2 font-mono">{i.ean}</td>
                    <td className="p-2">{i.nombre}</td>
                    <td className="p-2 text-right">{currency(i.precio)}</td>
                    <td className="p-2 text-right">
                      <input
                        type="number"
                        min={1}
                        className="w-20 border rounded-lg px-2 py-1 text-right"
                        value={i.qty}
                        onChange={(e) =>
                          setQty(i.id, parseInt(e.target.value || "1", 10))
                        }
                      />
                    </td>
                    <td className="p-2 text-right">
                      {currency(i.precio * i.qty)}
                    </td>
                    <td className="p-2 text-right">
                      <button
                        onClick={() => remove(i.id)}
                        className="text-red-600 hover:underline"
                      >
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-gray-500">
                      No hay artículos en esta venta
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
      <div>
        <Section title="Resumen">
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {["efectivo", "mercadopago", "posnet", "fiado"].map((m) => (
                <label
                  key={m}
                  className="flex items-center gap-2 border rounded-xl p-2 capitalize cursor-pointer hover:bg-gray-50"
                >
                  <input
                    type="radio"
                    name="metodo"
                    checked={metodo === m}
                    onChange={() => setMetodo(m)}
                  />
                  {m}
                </label>
              ))}
            </div>
            <div className="flex items-center justify-between text-lg font-semibold">
              <span>Total</span>
              <span>{currency(total)}</span>
            </div>
            <button
              onClick={finalizar}
              className="w-full bg-indigo-600 text-white rounded-xl py-2 hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-md"
              disabled={!items.length}
            >
              {metodo === "fiado" ? "Registrar fiado" : "Registrar venta"}
            </button>
          </div>
        </Section>
        <VentasRecientes data={data} setData={setData} />
      </div>
    </div>
  );
}

function VentasRecientes({ data, setData }) {
  const eliminarVenta = (id) => {
    if (!confirm("¿Eliminar esta venta?")) return;
    setData((s) => ({
      ...s,
      ventas: s.ventas.filter((v) => v.id !== id),
    }));
  };

  const actualizarMetodo = (id, metodo) => {
    setData((s) => ({
      ...s,
      ventas: s.ventas.map((v) => (v.id === id ? { ...v, metodo } : v)),
    }));
  };

  return (
    <Section title="Ventas recientes">
      <div className="space-y-3 max-h-[30vh] overflow-auto pr-1">
        {data.ventas.length === 0 && (
          <p className="text-sm text-gray-500">
            Aún no hay ventas registradas.
          </p>
        )}
        {data.ventas.map((v) => {
          // Verificar si la caja de esta venta ya está cerrada
          const fechaRef = v.fechaCaja || v.fecha.slice(0, 10);
          const isCerrado = data.cierres?.[fechaRef]?.cerrado;

          return (
            <div key={v.id} className="border rounded-xl p-3 relative">
              <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
                <span>
                  {new Date(v.fecha).toLocaleString("es-AR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
                {isCerrado ? (
                  <span className="text-xs bg-gray-200 text-gray-600 px-2 py-1 rounded uppercase font-bold">
                    {v.metodo} (Cerrado)
                  </span>
                ) : (
                  <select
                    className="border rounded-lg px-2 py-1 text-xs uppercase"
                    value={v.metodo}
                    onChange={(e) => actualizarMetodo(v.id, e.target.value)}
                  >
                    <option value="efectivo">efectivo</option>
                    <option value="mercadopago">mercadopago</option>
                    <option value="posnet">posnet</option>
                  </select>
                )}
              </div>
              <div className="text-sm">
                {v.items.map((i) => (
                  <div key={i.id} className="flex items-center justify-between">
                    <span className="truncate mr-2">
                      {i.nombre} x{i.qty}
                    </span>
                    <span>{currency(i.precio * i.qty)}</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between mt-2 font-semibold">
                <span>Total</span>
                <span>{currency(v.total)}</span>
              </div>

              {!isCerrado && (
                <div className="flex justify-end mt-2">
                  <button
                    onClick={() => eliminarVenta(v.id)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Eliminar venta
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Section>
  );
}

// ---- Compras / Gastos ----
function ComprasGastos({ data, setData }) {
  const [tipo, setTipo] = useState("compra");
  const [proveedor, setProveedor] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [monto, setMonto] = useState("");

  const agregar = () => {
    const nombreProveedor = proveedor.trim();
    const n = parseMoneyInput(monto);
    if (!nombreProveedor) return alert("Ingresa el proveedor");
    if (!isFinite(n) || n <= 0) return alert("Ingresa un monto válido");

    const todayISO = new Date().toISOString().slice(0, 10);
    const fechaCaja = data.settings?.fechaCajaAbierta || todayISO;

    const item = {
      id: uid(),
      fecha: new Date().toISOString(),
      fechaCaja,
      tipo,
      proveedor: nombreProveedor,
      descripcion: descripcion.trim(),
      monto: n,
    };
    setData((s) => {
      const gastos = [item, ...(s.gastos || [])];
      const proveedoresActuales = s.proveedores || [];
      const yaExiste = proveedoresActuales.some(
        (p) => p.toLowerCase() === nombreProveedor.toLowerCase()
      );
      const proveedores = yaExiste
        ? proveedoresActuales
        : [...proveedoresActuales, nombreProveedor].sort();
      return { ...s, gastos, proveedores };
    });
    setProveedor("");
    setDescripcion("");
    setMonto("");
  };

  const eliminar = (id) => {
    if (!confirm("¿Eliminar este registro?")) return;

    setData((s) => {
      const itemToDelete = s.gastos.find((g) => g.id === id);
      if (!itemToDelete) return s;

      const newGastos = s.gastos.filter((g) => g.id !== id);

      // Verificar si el proveedor se sigue usando
      const providerName = itemToDelete.proveedor;
      const isProviderUsed = newGastos.some(
        (g) => g.proveedor.toLowerCase() === providerName.toLowerCase()
      );

      let newProveedores = s.proveedores;
      if (!isProviderUsed) {
        newProveedores = s.proveedores.filter(
          (p) => p.toLowerCase() !== providerName.toLowerCase()
        );
      }

      return { ...s, gastos: newGastos, proveedores: newProveedores };
    });
  };

  const proveedores = data.proveedores || [];
  const registros = data.gastos || [];

  return (
    <Section
      title="Compras y gastos"
      desc="Registra compras y gastos diarios."
      right={
        <button
          onClick={agregar}
          className="px-3 py-1.5 rounded-xl border hover:bg-gray-50"
        >
          + Agregar
        </button>
      }
    >
      <div className="grid md:grid-cols-4 gap-3 mb-4">
        <select
          className="border rounded-xl px-3 py-2"
          value={tipo}
          onChange={(e) => setTipo(e.target.value)}
        >
          <option value="compra">Compra</option>
          <option value="gasto">Gasto</option>
        </select>
        <div className="flex flex-col">
          <input
            className="border rounded-xl px-3 py-2"
            placeholder="Proveedor"
            list="proveedores-list"
            value={proveedor}
            onChange={(e) => setProveedor(e.target.value)}
          />
          <datalist id="proveedores-list">
            {proveedores.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </div>
        <input
          className="border rounded-xl px-3 py-2"
          placeholder="Descripción (opcional)"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
        />
        <input
          type="text"
          className="border rounded-xl px-3 py-2"
          placeholder="Monto (ej: 1234,50)"
          value={monto}
          onChange={(e) => setMonto(e.target.value)}
        />
      </div>

      <div className="overflow-auto max-h-[50vh] border rounded-2xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="text-left p-2">Fecha</th>
              <th className="text-left p-2">Tipo</th>
              <th className="text-left p-2">Proveedor</th>
              <th className="text-left p-2">Descripción</th>
              <th className="text-right p-2">Monto</th>
              <th className="text-right p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {registros.map((g) => (
              <tr key={g.id} className="odd:bg-white even:bg-gray-50">
                <td className="p-2">
                  {new Date(g.fecha).toLocaleString("es-AR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </td>
                <td className="p-2 capitalize">{g.tipo}</td>
                <td className="p-2">{g.proveedor}</td>
                <td className="p-2">{g.descripcion}</td>
                <td className="p-2 text-right">{currency(g.monto)}</td>
                <td className="p-2 text-right">
                  <button
                    onClick={() => eliminar(g.id)}
                    className="text-red-600 hover:underline"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
            {!registros.length && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-gray-500">
                  Aún no hay compras ni gastos registrados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---- Cierre diario (Con Arqueo y Reabrir) ----
function CierreDiario({ data, setData }) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const initialDate = data.settings?.fechaCajaAbierta || todayISO;
  const [fecha, setFecha] = useState(initialDate);
  const [efectivoCajaProxDia, setEfectivoCajaProxDia] = useState("");
  const [efectivoPedidosYa, setEfectivoPedidosYa] = useState("");
  const [showArqueo, setShowArqueo] = useState(false);

  const cierres = data.cierres || {};

  useEffect(() => {
    const rec = cierres[fecha];
    if (rec) {
      setEfectivoCajaProxDia(
        rec.efectivoCajaProxDia != null ? String(rec.efectivoCajaProxDia) : ""
      );
      setEfectivoPedidosYa(
        rec.efectivoPedidosYa != null ? String(rec.efectivoPedidosYa) : ""
      );
    } else {
      setEfectivoCajaProxDia("");
      setEfectivoPedidosYa("");
    }
  }, [fecha, cierres]);

  const resumen = useMemo(() => {
    const ventasDia = data.ventas.filter((v) => {
      const fLogica = v.fechaCaja || v.fecha.slice(0, 10);
      return fLogica === fecha;
    });

    const gastosDia = (data.gastos || []).filter((g) => {
      const fLogica = g.fechaCaja || g.fecha.slice(0, 10);
      return fLogica === fecha;
    });

    const sumVentas = (metodo) =>
      ventasDia
        .filter((v) => v.metodo === metodo)
        .reduce((a, b) => a + (b.total || 0), 0);

    const totalVentas = ventasDia.reduce((a, b) => a + (b.total || 0), 0);
    const totalCompras = gastosDia
      .filter((g) => g.tipo === "compra")
      .reduce((a, b) => a + (b.monto || 0), 0);
    const totalGastos = gastosDia
      .filter((g) => g.tipo === "gasto")
      .reduce((a, b) => a + (b.monto || 0), 0);

    const totalEgresos = totalCompras + totalGastos;
    const netoDia = totalVentas - totalEgresos;

    return {
      ventasDia,
      gastosDia,
      porMetodo: {
        efectivo: sumVentas("efectivo"),
        mercadopago: sumVentas("mercadopago"),
        posnet: sumVentas("posnet"),
      },
      totalVentas,
      totalCompras,
      totalGastos,
      totalEgresos,
      netoDia,
    };
  }, [data.ventas, data.gastos, fecha]);

  const prevDateStr = useMemo(() => {
    const d = new Date(fecha + "T00:00:00");
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }, [fecha]);

  const dineroCajaDiaAnterior = parseMoneyInput(
    (cierres[prevDateStr] && cierres[prevDateStr].efectivoCajaProxDia) || 0
  );

  const efectivoCajaNum = parseMoneyInput(efectivoCajaProxDia);
  const efectivoPedidosYaNum = parseMoneyInput(efectivoPedidosYa);
  const efectivoTotalDisponible =
    resumen.porMetodo.efectivo +
    dineroCajaDiaAnterior +
    efectivoPedidosYaNum -
    efectivoCajaNum;

  const cerrado = !!(cierres[fecha] && cierres[fecha].cerrado);

  const updateCierreValue = (field, rawValue) => {
    const num = parseMoneyInput(rawValue);
    setData((s) => ({
      ...s,
      cierres: {
        ...s.cierres,
        [fecha]: {
          ...(s.cierres?.[fecha] || {}),
          [field]: num,
          cerrado: s.cierres?.[fecha]?.cerrado || false,
        },
      },
    }));
  };

  const onChangeCajaProxDia = (value) => {
    setEfectivoCajaProxDia(value);
    if (!cerrado) updateCierreValue("efectivoCajaProxDia", value);
  };

  const onChangePedidosYa = (value) => {
    setEfectivoPedidosYa(value);
    if (!cerrado) updateCierreValue("efectivoPedidosYa", value);
  };

  const toggleCierre = () => {
    if (cerrado) {
      // REABRIR
      if (!confirm("¿Reabrir caja? Las nuevas ventas se asignarán a esta fecha."))
        return;
      setData((s) => ({
        ...s,
        settings: { ...s.settings, fechaCajaAbierta: fecha },
        cierres: {
          ...s.cierres,
          [fecha]: { ...(s.cierres[fecha] || {}), cerrado: false },
        },
      }));
    } else {
      // CERRAR
      if (
        !confirm("¿Confirmar cierre definitivo? Se abrirá una nueva caja.")
      )
        return;
      const caja = efectivoCajaNum;
      const pedYa = efectivoPedidosYaNum;

      const currentRealDate = new Date().toISOString().slice(0, 10);
      let nextDate = currentRealDate;
      if (fecha === currentRealDate) {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        nextDate = d.toISOString().slice(0, 10);
      }

      setData((s) => ({
        ...s,
        settings: { ...s.settings, fechaCajaAbierta: nextDate },
        cierres: {
          ...s.cierres,
          [fecha]: {
            ...(s.cierres?.[fecha] || {}),
            efectivoCajaProxDia: caja,
            efectivoPedidosYa: pedYa,
            cerrado: true,
          },
        },
      }));
      alert(`Día cerrado. Se ha abierto la caja para la fecha: ${nextDate}`);
      setFecha(nextDate);
    }
  };

  return (
    <Section
      title="Cierre diario"
      desc="Totales acumulados. 'Cerrar Caja' finaliza este día y abre el siguiente."
      right={
        <div className="flex gap-2">
          <button
            onClick={toggleCierre}
            className={
              "px-3 py-1.5 rounded-xl border text-sm font-bold transition-colors " +
              (cerrado
                ? "border-green-500 text-green-700 bg-green-50 hover:bg-green-100"
                : "border-red-500 text-red-700 bg-red-50 hover:bg-red-100")
            }
          >
            {cerrado ? "🔓 Reabrir Caja" : "🔒 Cerrar Caja"}
          </button>
          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 rounded-xl border hover:bg-gray-50 text-sm"
          >
            Imprimir / PDF
          </button>
        </div>
      }
    >
      <div className="flex items-center gap-3 mb-4 bg-gray-50 p-2 rounded-xl border border-gray-100">
        <label className="text-sm text-gray-700 font-medium">
          Fecha de Caja
        </label>
        <input
          type="date"
          className="border rounded-lg px-2 py-1"
          value={fecha}
          onChange={(e) => setFecha(e.target.value)}
        />
        {fecha === (data.settings?.fechaCajaAbierta || todayISO) &&
          !cerrado && (
            <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full font-bold border border-green-200">
              Caja Actual (Abierta)
            </span>
          )}
        {cerrado && (
          <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded-full font-bold border border-red-200">
            CERRADA
          </span>
        )}
      </div>

      <div className="grid md:grid-cols-3 gap-3 mb-4">
        <CardStat
          label="Efectivo"
          value={currency(resumen.porMetodo.efectivo)}
        />
        <CardStat
          label="MercadoPago"
          value={currency(resumen.porMetodo.mercadopago)}
        />
        <CardStat
          label="Posnet"
          value={currency(resumen.porMetodo.posnet)}
        />
      </div>

      <div className="grid md:grid-cols-4 gap-3 mb-6">
        <CardStat
          label="Total ventas"
          value={currency(resumen.totalVentas)}
          variant="primary"
        />
        <CardStat
          label="Total compras"
          value={currency(resumen.totalCompras)}
        />
        <CardStat
          label="Total gastos"
          value={currency(resumen.totalGastos)}
        />
        <CardStat
          label="Neto (ventas - egresos)"
          value={currency(resumen.netoDia)}
          variant="primary"
        />
      </div>

      <div className="grid md:grid-cols-4 gap-3 mb-6">
        <CardStat
          label="Caja día anterior"
          value={currency(dineroCajaDiaAnterior)}
        />
        <CardStat
          label="Efectivo Total Disponible"
          value={currency(efectivoTotalDisponible)}
          variant="accent"
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <div
          className={`border rounded-2xl p-4 ${
            cerrado ? "bg-gray-50" : "bg-white"
          }`}
        >
          <div className="flex justify-between items-center mb-2">
            <label className="block text-sm text-gray-700 font-medium">
              Efectivo en caja para próximo día
            </label>
            {!cerrado && (
              <button
                onClick={() => setShowArqueo(true)}
                className="text-indigo-600 text-sm font-bold hover:underline flex items-center gap-1"
              >
                🧮 Asistente
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">$</span>
            <input
              type="text"
              className="flex-1 border rounded-xl px-3 py-2 font-bold text-lg"
              placeholder="0"
              value={efectivoCajaProxDia}
              onChange={(e) => onChangeCajaProxDia(e.target.value)}
              disabled={cerrado}
            />
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Valor formateado:{" "}
            <span className="font-medium">{currency(efectivoCajaNum)}</span>
          </div>
        </div>
        <div
          className={`border rounded-2xl p-4 ${
            cerrado ? "bg-gray-50" : "bg-white"
          }`}
        >
          <label className="block text-sm text-gray-700 font-medium mb-2">
            Efectivo de PedidosYa
          </label>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">$</span>
            <input
              type="text"
              className="flex-1 border rounded-xl px-3 py-2 font-bold text-lg"
              placeholder="0"
              value={efectivoPedidosYa}
              onChange={(e) => onChangePedidosYa(e.target.value)}
              disabled={cerrado}
            />
          </div>
          <div className="text-xs text-gray-500 mt-1">
            Valor formateado:{" "}
            <span className="font-medium">
              {currency(efectivoPedidosYaNum)}
            </span>
          </div>
        </div>
      </div>

      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        Ventas de esta caja
      </h3>
      <div className="overflow-auto max-h-[40vh] border rounded-2xl mb-6">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="text-left p-2">Hora</th>
              <th className="text-left p-2">Método</th>
              <th className="text-right p-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {resumen.ventasDia.map((v) => (
              <tr key={v.id} className="odd:bg-white even:bg-gray-50">
                <td className="p-2">
                  {new Date(v.fecha).toLocaleTimeString("es-AR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="p-2 uppercase">{v.metodo}</td>
                <td className="p-2 text-right">{currency(v.total)}</td>
              </tr>
            ))}
            {!resumen.ventasDia.length && (
              <tr>
                <td colSpan={3} className="p-6 text-center text-gray-500">
                  Sin ventas en esta fecha
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="text-sm font-semibold text-gray-700 mb-2">
        Compras y gastos
      </h3>
      <div className="overflow-auto max-h-[40vh] border rounded-2xl">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 sticky top-0">
            <tr>
              <th className="text-left p-2">Hora</th>
              <th className="text-left p-2">Tipo</th>
              <th className="text-left p-2">Proveedor</th>
              <th className="text-left p-2">Descripción</th>
              <th className="text-right p-2">Monto</th>
            </tr>
          </thead>
          <tbody>
            {resumen.gastosDia.map((g) => (
              <tr key={g.id} className="odd:bg-white even:bg-gray-50">
                <td className="p-2">
                  {new Date(g.fecha).toLocaleTimeString("es-AR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="p-2 capitalize">{g.tipo}</td>
                <td className="p-2">{g.proveedor}</td>
                <td className="p-2">{g.descripcion}</td>
                <td className="p-2 text-right">{currency(g.monto)}</td>
              </tr>
            ))}
            {!resumen.gastosDia.length && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-gray-500">
                  Sin compras ni gastos en esta fecha
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showArqueo && (
        <ArqueoCaja
          onClose={() => setShowArqueo(false)}
          onConfirm={(total) => {
            onChangeCajaProxDia(String(total));
            setShowArqueo(false);
          }}
        />
      )}
    </Section>
  );
}

// ---- Resumen histórico (Simplificado) ----
function ResumenHistorico({ data, setData }) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const [desde, setDesde] = useState(todayISO);
  const [hasta, setHasta] = useState(todayISO);

  const { valido, resumen } = useMemo(() => {
    if (!desde || !hasta) return { valido: false, resumen: null };
    if (desde > hasta) return { valido: false, resumen: null };

    const d0 = new Date(desde + "T00:00:00").getTime();
    const d1 = new Date(hasta + "T23:59:59.999").getTime();

    const ventasRango = data.ventas.filter((v) => {
      const t = new Date(v.fecha).getTime();
      return t >= d0 && t <= d1;
    });

    const gastosRango = (data.gastos || []).filter((g) => {
      const t = new Date(g.fecha).getTime();
      return t >= d0 && t <= d1;
    });

    const totalVentas = ventasRango.reduce((acc, v) => acc + (v.total || 0), 0);
    const totalCompras = gastosRango
      .filter((g) => g.tipo === "compra")
      .reduce((acc, g) => acc + (g.monto || 0), 0);
    const totalGastos = gastosRango
      .filter((g) => g.tipo === "gasto")
      .reduce((acc, g) => acc + (g.monto || 0), 0);

    const totalGeneral = totalVentas - totalCompras - totalGastos;

    return {
      valido: true,
      resumen: {
        ventasRango,
        gastosRango,
        totalVentas,
        totalCompras,
        totalGastos,
        totalGeneral,
      },
    };
  }, [data.ventas, data.gastos, desde, hasta]);

  const exportPdf = () => {
    if (!valido || !resumen) {
      return alert("Configura un rango válido.");
    }

    const {
      totalVentas,
      totalCompras,
      totalGastos,
      totalGeneral,
      gastosRango,
    } = resumen;

    const rowsHtml = gastosRango
      .map((g) => {
        const fecha = new Date(g.fecha);
        const fechaStr = fecha.toLocaleDateString("es-AR");
        const horaStr = fecha.toLocaleTimeString("es-AR", {
          hour: "2-digit",
          minute: "2-digit",
        });
        return `
          <tr>
            <td>${fechaStr}</td>
            <td>${horaStr}</td>
            <td>${g.tipo}</td>
            <td>${escapeHtml(g.proveedor)}</td>
            <td>${escapeHtml(g.descripcion || "")}</td>
            <td style="text-align:right;">${currency(g.monto)}</td>
          </tr>
        `;
      })
      .join("");

    const w = window.open("", "_blank");
    if (!w) return alert("Revisa el bloqueador de popups.");

    const html = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>Resumen histórico</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 20px; font-family: sans-serif; font-size: 12px; }
          h1 { font-size: 18px; margin-bottom: 5px; }
          .range { margin-bottom: 15px; color: #555; }
          .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 20px; }
          .card { border: 1px solid #ccc; padding: 10px; border-radius: 5px; }
          .val { font-size: 16px; font-weight: bold; margin-top: 5px; }
          table { width: 100%; border-collapse: collapse; }
          th, td { border: 1px solid #ccc; padding: 5px; text-align: left; }
          th { background: #f0f0f0; }
        </style>
      </head>
      <body onload="window.print()">
        <h1>Resumen Histórico</h1>
        <div class="range">Del ${desde} al ${hasta}</div>
        <div class="grid">
          <div class="card"><div>Ventas</div><div class="val">${currency(
            totalVentas
          )}</div></div>
          <div class="card"><div>Compras</div><div class="val">${currency(
            totalCompras
          )}</div></div>
          <div class="card"><div>Gastos</div><div class="val">${currency(
            totalGastos
          )}</div></div>
          <div class="card"><div>NETO</div><div class="val">${currency(
            totalGeneral
          )}</div></div>
        </div>
        <h3>Detalle de compras/gastos</h3>
        <table>
          <thead><tr><th>Fecha</th><th>Hora</th><th>Tipo</th><th>Proveedor</th><th>Desc</th><th>Monto</th></tr></thead>
          <tbody>${
            rowsHtml || "<tr><td colspan='6'>Sin movimientos</td></tr>"
          }</tbody>
        </table>
      </body>
      </html>
    `;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <Section
      title="Resumen histórico"
      desc="Reporte de ventas, compras y gastos por rango de fechas."
      right={
        <button
          onClick={exportPdf}
          className="px-3 py-1.5 rounded-xl border text-sm hover:bg-gray-50"
        >
          Imprimir / PDF
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-700">Desde</label>
          <input
            type="date"
            className="border rounded-xl px-3 py-2"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-700">Hasta</label>
          <input
            type="date"
            className="border rounded-xl px-3 py-2"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
          />
        </div>
      </div>

      {!valido && (
        <p className="text-sm text-red-600 mb-4">Rango de fechas inválido.</p>
      )}

      {valido && resumen && (
        <>
          <div className="grid md:grid-cols-4 gap-3 mb-6">
            <CardStat
              label="Total ventas"
              value={currency(resumen.totalVentas)}
              variant="primary"
            />
            <CardStat
              label="Total compras"
              value={currency(resumen.totalCompras)}
            />
            <CardStat
              label="Total gastos"
              value={currency(resumen.totalGastos)}
            />
            <CardStat
              label="Neto"
              value={currency(resumen.totalGeneral)}
              variant="accent"
            />
          </div>

          <h3 className="text-sm font-semibold text-gray-700 mb-2">
            Compras y gastos en el rango
          </h3>
          <div className="overflow-auto max-h-[40vh] border rounded-2xl">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 sticky top-0">
                <tr>
                  <th className="text-left p-2">Fecha</th>
                  <th className="text-left p-2">Hora</th>
                  <th className="text-left p-2">Tipo</th>
                  <th className="text-left p-2">Proveedor</th>
                  <th className="text-left p-2">Descripción</th>
                  <th className="text-right p-2">Monto</th>
                </tr>
              </thead>
              <tbody>
                {resumen.gastosRango.map((g) => (
                  <tr key={g.id} className="odd:bg-white even:bg-gray-50">
                    <td className="p-2">
                      {new Date(g.fecha).toLocaleDateString("es-AR")}
                    </td>
                    <td className="p-2">
                      {new Date(g.fecha).toLocaleTimeString("es-AR", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="p-2 capitalize">{g.tipo}</td>
                    <td className="p-2">{g.proveedor}</td>
                    <td className="p-2">{g.descripcion}</td>
                    <td className="p-2 text-right">{currency(g.monto)}</td>
                  </tr>
                ))}
                {!resumen.gastosRango.length && (
                  <tr>
                    <td colSpan={6} className="p-6 text-center text-gray-500">
                      No hay movimientos en este rango.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Section>
  );
}

// ---- Ranking de ventas ----
function RankingVentas({ email }) {
  const [desde, setDesde] = React.useState("");
  const [hasta, setHasta] = React.useState("");
  const [data, setData] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  async function cargarRanking() {
    if (!email) {
      setError("Debe indicar un email válido.");
      return;
    }
    setLoading(true);
    setError("");
    setData(null);
    try {
      const params = new URLSearchParams();
      params.set("email", email);
      if (desde) params.set("desde", desde);
      if (hasta) params.set("hasta", hasta);

      const res = await fetch(
        `${API_URL}/ranking-ventas?${params.toString()}`
      );
      if (!res.ok) {
        throw new Error("Error al obtener ranking");
      }
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error(err);
      setError("No se pudo cargar el ranking de ventas.");
    } finally {
      setLoading(false);
    }
  }

  React.useEffect(() => {
    if (email) {
      cargarRanking();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  return (
    <Section
      title="Ranking de ventas"
      desc="Calculado directamente desde el backend según el historial de ventas."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="block text-sm font-medium mb-1">Desde</label>
            <input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="border rounded-xl px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Hasta</label>
            <input
              type="date"
              value={hasta}
              onChange={(e) => setHasta(e.target.value)}
              className="border rounded-xl px-3 py-1.5 text-sm"
            />
          </div>
          <button
            onClick={cargarRanking}
            disabled={loading}
            className="px-3 py-2 rounded-xl bg-indigo-600 text-white text-sm disabled:opacity-50 hover:bg-indigo-700"
          >
            {loading ? "Calculando..." : "Calcular"}
          </button>
        </div>

        {error && <div className="text-red-600 text-sm">{error}</div>}

        {data && (
          <div className="space-y-2">
            <div className="font-semibold">
              Total ventas del período:{" "}
              {data.totalVentas.toLocaleString("es-AR", {
                style: "currency",
                currency: "ARS",
                minimumFractionDigits: 2,
              })}
            </div>

            <div className="overflow-auto max-h-96 border rounded-2xl">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-1 text-left">#</th>
                    <th className="px-2 py-1 text-left">EAN</th>
                    <th className="px-2 py-1 text-left">Producto</th>
                    <th className="px-2 py-1 text-right">Cantidad</th>
                    <th className="px-2 py-1 text-right">Total</th>
                    <th className="px-2 py-1 text-right">% del total</th>
                  </tr>
                </thead>
                <tbody>
                  {data.productos.map((p, idx) => (
                    <tr
                      key={`${p.ean}-${p.nombre}-${idx}`}
                      className="border-t odd:bg-white even:bg-gray-50"
                    >
                      <td className="px-2 py-1">{idx + 1}</td>
                      <td className="px-2 py-1">{p.ean}</td>
                      <td className="px-2 py-1">{p.nombre}</td>
                      <td className="px-2 py-1 text-right">{p.cantidad}</td>
                      <td className="px-2 py-1 text-right">
                        {p.total.toLocaleString("es-AR", {
                          style: "currency",
                          currency: "ARS",
                          minimumFractionDigits: 2,
                        })}
                      </td>
                      <td className="px-2 py-1 text-right">
                        {p.porcentaje.toFixed(2)} %
                      </td>
                    </tr>
                  ))}
                  {data.productos.length === 0 && (
                    <tr>
                      <td
                        colSpan={6}
                        className="px-2 py-4 text-center text-gray-500"
                      >
                        No hay ventas registradas en el rango seleccionado.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Section>
  );
}

// ---- Fiados ----
function Fiados({ data, setData }) {
  const personas = data.fiados || [];
  const productos = data.productos || [];

  const [abonoNombre, setAbonoNombre] = useState("");
  const [abonoMonto, setAbonoMonto] = useState("");

  const personasConSaldo = useMemo(
    () =>
      personas
        .map((p) => ({
          ...p,
          saldo: computeSaldoPersona(p, productos),
        }))
        .filter((p) => p.saldo > 0.0001),
    [personas, productos]
  );

  const agregarAbono = () => {
    const nombre = abonoNombre.trim();
    const monto = parseMoneyInput(abonoMonto);
    if (!nombre) return alert("Ingresa el nombre de la persona.");
    if (!isFinite(monto) || monto <= 0) return alert("Ingresa un monto válido.");

    const existe = personas.find(
      (p) => p.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (!existe) return alert("No se encontró esa persona en Fiados.");

    const pass = prompt("Ingresa la contraseña para registrar el abono:");
    if (pass !== "19256436") {
      return alert("Contraseña incorrecta.");
    }

    setData((s) => {
      const productosS = s.productos || [];
      let fiados = (s.fiados || []).map((p) => {
        if (p.nombre.toLowerCase() !== nombre.toLowerCase()) return p;
        return {
          ...p,
          abonos: [
            {
              id: uid(),
              fecha: new Date().toISOString(),
              monto,
            },
            ...(p.abonos || []),
          ],
        };
      });
      fiados = fiados.filter(
        (p) => computeSaldoPersona(p, productosS) > 0.0001
      );
      return { ...s, fiados };
    });

    setAbonoNombre("");
    setAbonoMonto("");
    alert("Abono registrado.");
  };

  const nombresFiados = personasConSaldo.map((p) => p.nombre);

  return (
    <Section
      title="Fiados"
      desc="Personas con deudas. El saldo se recalcula automáticamente."
    >
      <div className="grid md:grid-cols-3 gap-3 mb-4">
        <div className="flex flex-col gap-1 md:col-span-1">
          <label className="text-sm text-gray-700">Nombre (para abono)</label>
          <input
            className="border rounded-xl px-3 py-2"
            placeholder="Ej: Juan Pérez"
            list="fiados-personas-list"
            value={abonoNombre}
            onChange={(e) => setAbonoNombre(e.target.value)}
          />
          <datalist id="fiados-personas-list">
            {nombresFiados.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1 md:col-span-1">
          <label className="text-sm text-gray-700">Importe del abono</label>
          <input
            type="text"
            className="border rounded-xl px-3 py-2"
            placeholder="Ej: 1500,00"
            value={abonoMonto}
            onChange={(e) => setAbonoMonto(e.target.value)}
          />
        </div>
        <div className="flex items-end md:col-span-1">
          <button
            onClick={agregarAbono}
            className="w-full bg-indigo-600 text-white rounded-xl py-2 hover:bg-indigo-700 mt-2 md:mt-0 shadow-md"
          >
            Agregar abono
          </button>
        </div>
      </div>

      {personasConSaldo.length === 0 ? (
        <p className="text-sm text-gray-500">No hay fiados activos.</p>
      ) : (
        <div className="space-y-4 max-h-[60vh] overflow-auto pr-1">
          {personasConSaldo.map((p) => {
            const cargos = p.cargos || [];
            const abonos = p.abonos || [];
            const mapProd = new Map(productos.map((pr) => [pr.ean, pr]));

            return (
              <div key={p.id} className="border rounded-2xl p-4 bg-white/80">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-semibold">{p.nombre}</h3>
                  <span className="text-sm text-gray-600">
                    Saldo actual:{" "}
                    <span className="font-semibold">{currency(p.saldo)}</span>
                  </span>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-1">
                      Ventas fiadas
                    </h4>
                    <div className="border rounded-xl max-h-48 overflow-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="text-left p-1.5">Fecha</th>
                            <th className="text-left p-1.5">Detalle</th>
                            <th className="text-right p-1.5">Monto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cargos.map((c) => {
                            let totalCargo = 0;
                            const detalle = (c.items || []).map((it, idx) => {
                              const prod = mapProd.get(it.ean);
                              const nombreProd =
                                prod?.nombre || `Producto sin nombre`;
                              const qty = Number(it.qty) || 0;
                              const precioBase =
                                typeof it.precioUnitario === "number"
                                  ? it.precioUnitario
                                  : prod
                                  ? Number(prod.precio) || 0
                                  : 0;
                              const sub = precioBase * qty;
                              totalCargo += sub;
                              return (
                                <div
                                  key={idx}
                                  className="flex justify-between gap-2"
                                >
                                  <span className="truncate">
                                    EAN {it.ean} - x{qty} {nombreProd}
                                  </span>
                                  <span>{currency(sub)}</span>
                                </div>
                              );
                            });
                            return (
                              <tr
                                key={c.id}
                                className="odd:bg-white even:bg-gray-50 align-top"
                              >
                                <td className="p-1.5">
                                  {new Date(c.fecha).toLocaleString("es-AR", {
                                    dateStyle: "short",
                                    timeStyle: "short",
                                  })}
                                </td>
                                <td className="p-1.5">{detalle}</td>
                                <td className="p-1.5 text-right align-top whitespace-nowrap">
                                  {currency(totalCargo)}
                                </td>
                              </tr>
                            );
                          })}
                          {!cargos.length && (
                            <tr>
                              <td
                                colSpan={3}
                                className="p-3 text-center text-gray-400"
                              >
                                Sin ventas fiadas
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-gray-700 mb-1">
                      Abonos
                    </h4>
                    <div className="border rounded-xl max-h-48 overflow-auto">
                      <table className="w-full text-xs">
                        <thead className="bg-gray-50 sticky top-0">
                          <tr>
                            <th className="text-left p-1.5">Fecha</th>
                            <th className="text-right p-1.5">Monto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {abonos.map((a) => (
                            <tr
                              key={a.id}
                              className="odd:bg-white even:bg-gray-50"
                            >
                              <td className="p-1.5">
                                {new Date(a.fecha).toLocaleString("es-AR", {
                                  dateStyle: "short",
                                  timeStyle: "short",
                                })}
                              </td>
                              <td className="p-1.5 text-right">
                                {currency(a.monto)}
                              </td>
                            </tr>
                          ))}
                          {!abonos.length && (
                            <tr>
                              <td
                                colSpan={2}
                                className="p-3 text-center text-gray-400"
                              >
                                Sin abonos registrados
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function CardStat({ label, value, variant = "normal" }) {
  const variantClasses =
    variant === "primary"
      ? "bg-indigo-50 border-indigo-300"
      : variant === "accent"
      ? "bg-emerald-50 border-emerald-300"
      : "bg-white border-gray-200";

  return (
    <div className={`border rounded-2xl p-4 ${variantClasses} shadow-sm`}>
      <div className="text-sm text-gray-600">{label}</div>
      <div className="text-2xl font-semibold">{value}</div>
    </div>
  );
}

// ---- Navegación ----
function Nav({ tab, setTab }) {
  const tabs = [
    { id: "productos", label: "Productos" },
    { id: "venta", label: "Nueva venta" },
    { id: "gastos", label: "Compras/Gastos" },
    { id: "fiados", label: "Fiados" },
    { id: "cierre", label: "Cierre diario" },
    { id: "ranking", label: "Ranking de ventas" },
    { id: "historico", label: "Resumen histórico" },
    { id: "io", label: "Importar/Exportar" },
  ];
  return (
    <nav className="flex gap-2 p-2 bg-white/80 backdrop-blur border-b border-gray-200 sticky top-[57px] z-20 overflow-x-auto">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={
            "px-3 py-1.5 rounded-xl border text-sm whitespace-nowrap transition-all " +
            (tab === t.id
              ? "bg-gray-900 text-white shadow-md"
              : "hover:bg-gray-50 text-gray-700")
          }
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

// ---- App principal (CON PANTALLA DE CARGA) ----
export default function DespensaApp() {
  const [email, setEmail] = useState(
    localStorage.getItem("despensa:lastEmail") || ""
  );
  const [data, setData, isLoaded] = useUserStorage(email);
  const [tab, setTab] = useState("productos");

  useEffect(() => {
    if (email) localStorage.setItem("despensa:lastEmail", email);
  }, [email]);

  const logout = () => setEmail("");

  // 1. Login Screen
  if (!email) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-white text-gray-900 font-sans">
        <Login onLogin={setEmail} />
        <footer className="text-center text-xs text-gray-500 py-6">
          APP Local de Despensa v1.6
        </footer>
      </div>
    );
  }

  // 2. Loading Screen (Protección de datos)
  if (!isLoaded) {
    return (
      <div className="min-h-screen grid place-items-center bg-indigo-50 text-indigo-900">
        <div className="text-center animate-pulse">
          <div className="text-6xl mb-4">🧺</div>
          <h2 className="text-2xl font-semibold">Sincronizando tu despensa...</h2>
          <p className="text-indigo-600 mt-2">Por favor espera un momento</p>
        </div>
      </div>
    );
  }

  // 3. Main App
  return (
    <div className="min-h-screen bg-gradient-to-b from-indigo-50 to-white text-gray-900 font-sans">
      <TopBar email={email} onLogout={logout} />
      <Nav tab={tab} setTab={setTab} />
      <main className="max-w-6xl mx-auto p-4 space-y-4 pb-20">
        {tab === "productos" && <Productos data={data} setData={setData} />}
        {tab === "venta" && <NuevaVenta data={data} setData={setData} />}
        {tab === "gastos" && <ComprasGastos data={data} setData={setData} />}
        {tab === "fiados" && <Fiados data={data} setData={setData} />}
        {tab === "cierre" && <CierreDiario data={data} setData={setData} />}
        {tab === "ranking" && <RankingVentas email={email} />}
        {tab === "historico" && (
          <ResumenHistorico data={data} setData={setData} />
        )}
        {tab === "io" && <ImportExport data={data} setData={setData} />}
      </main>
      <footer className="text-center text-xs text-gray-500 py-6">
        APP Local de Despensa v1.6
      </footer>
    </div>
  );
}
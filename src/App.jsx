import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * DespensaApp – MVP
 * -----------------------------------------
 * ✔ Login simple por email (localStorage por usuario)
 * ✔ Productos con EAN, nombre, precio
 * ✔ No permite EAN duplicados (alta manual)
 * ✔ Importar productos desde CSV (ean,nombre,precio)
 * ✔ Listado con búsqueda + precio editable inline
 * ✔ Precio PedidosYa / Rappi calculados desde el precio base
 * ✔ Productos seleccionables para generar etiquetas e imprimir PDF
 * ✔ Eliminar productos de forma masiva usando la misma selección
 * ✔ Nueva venta:
 *    - Buscar por código EAN (sin distinguir mayúsculas/minúsculas)
 *    - Si el producto tiene precio 0 → ventana emergente SIEMPRE, sin actualizar el catálogo
 *    - Métodos de pago: efectivo, MercadoPago, posnet, fiado
 * ✔ Ventas normales → van a "ventas" (cierre diario y resumen histórico)
 * ✔ Ventas en fiado:
 *    - No se guardan en "ventas" → no impactan cierre diario ni resumen histórico
 *    - Se guardan por persona en "fiados" (con detalle de productos)
 *    - Para productos con precio 0, se guarda precioUnitario y NO se actualiza nunca
 * ✔ Fiados:
 *    - Personas con deudas, detalle de compras fiadas y abonos
 *    - Saldo = sum(productos * cantidades) usando:
 *         - precioUnitario si existe (congelado)
 *         - o precio actual del producto si no tiene precioUnitario
 *    - Abonos protegidos con contraseña (19256436)
 *    - Muestra EAN + nombre de producto en detalle
 *    - Si saldo queda en 0 → se borra la persona de fiados
 * ✔ Ventas recientes:
 *    - Se puede cambiar el método de pago sin borrar la venta (si no está en día cerrado y no es multipago)
 * ✔ Compras / Gastos:
 *    - Registrar tipo (compra/gasto), proveedor, descripción, monto (con decimales)
 *    - Lista de proveedores reutilizable (datalist)
 * ✔ Cierre diario:
 *    - Totales por método de pago (solo ventas normales)
 *    - Total ventas, compras, gastos, neto del día
 *    - Dinero en caja (día anterior) desde cierre anterior
 *    - Efectivo Total Disponible = efectivo día + caja día anterior + PedidosYa - caja próximo día
 *    - Cierre definitivo bloquea edición de efectivo y elimina ventas de ese día
 *    - Las ventas se acumulan hasta el cierre, aunque pasen las 00:00
 *    - Se puede reabrir un día cerrado
 * ✔ Resumen histórico:
 *    - Rango de fechas
 *    - Totales de ventas, compras, gastos
 *    - Total general (ventas - compras - gastos)
 *    - Sin detalle de ventas, solo detalle de compras/gastos
 *    - Botón Imprimir / PDF simple
 * ✔ Ranking de ventas:
 *    - Rango de fechas
 *    - Agrupa por producto
 *    - Ordenado por cantidad vendida
 *    - Porcentaje de participación por cantidad
 * ✔ Importar/Exportar:
 *    - Importar CSV de productos
 *    - Exportar respaldo JSON (incluye todo)
 */

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";
console.log("API_URL EN RUNTIME:", API_URL);

const currency = (n) =>
  new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
  }).format(Number.isFinite(+n) ? +n : 0);

const uid = () => Math.random().toString(36).slice(2, 10);

// Precio para PedidosYa: precio / (1 - 29.5%)
const pedidosYaPrice = (precio) => {
  const base = Number(precio) || 0;
  if (base <= 0) return 0;
  return Math.ceil(base / (1 - 0.295));
};

// Precio para Rappi: precio / (1 - 20%)
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
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
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

// ---- Almacenamiento por usuario ----
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

  // Nueva pieza de estado: fecha/hora del último backup local
  const [lastBackupAt, setLastBackupAt] = useState(null);

  useEffect(() => {
    if (!email) return;
    const controller = new AbortController();
    const BACKUP_KEY = `despensa:backup:${email}`;

    async function fetchState() {
      // 1) Intentar leer backup local (por si el backend falla)
      let backup = null;
      try {
        const raw = localStorage.getItem(BACKUP_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.version === 1 && parsed.state) {
            backup = parsed;
            if (typeof parsed.updatedAt === "string") {
              setLastBackupAt(parsed.updatedAt);
            }
          }
        }
      } catch (e) {
        console.error("Error leyendo backup local:", e);
      }

      // 2) Intentar cargar desde backend
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
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error(
          "Error cargando estado desde backend, usando backup local si existe:",
          err
        );
        if (backup && backup.state) {
          // Si hay backup local, lo usamos
          setState({
            productos: [],
            ventas: [],
            gastos: [],
            proveedores: [],
            cierres: {},
            fiados: [],
            settings: {},
            ...(backup.state || {}),
          });
        } else {
          // Si no hay backend ni backup, dejamos todo vacío
          setState({
            productos: [],
            ventas: [],
            gastos: [],
            proveedores: [],
            cierres: {},
            fiados: [],
            settings: {},
          });
        }
      }
    }

    fetchState();
    return () => controller.abort();
  }, [email]);

  useEffect(() => {
    if (!email) return;
    const controller = new AbortController();
    const BACKUP_KEY = `despensa:backup:${email}`;

    const timeout = setTimeout(async () => {
      // 1) Guardar SIEMPRE backup local
      try {
        const now = new Date().toISOString();
        const payload = {
          version: 1,
          updatedAt: now,
          state,
        };
        localStorage.setItem(BACKUP_KEY, JSON.stringify(payload));
        setLastBackupAt(now);
      } catch (err) {
        console.error("Error guardando backup local:", err);
      }

      // 2) Guardar en backend (como ya hacíamos antes)
      try {
        await fetch(`${API_URL}/estado?email=${encodeURIComponent(email)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(state),
          signal: controller.signal,
        });
      } catch (err) {
        if (err.name === "AbortError") return;
        console.error("Error guardando estado en backend:", err);
      }
    }, 500);

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [email, state]);

  // 👉 Ahora devolvemos también lastBackupAt
  return [state, setState, lastBackupAt];
}

// ---- Layout ----
function Section({ title, desc, children, right }) {
  return (
    <div className="bg-white shadow-sm rounded-2xl p-5 border border-slate-200">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">{title}</h2>
          {desc && <p className="text-sm text-slate-500">{desc}</p>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function TopBar({ email, onLogout, lastBackupAt }) {
  // Texto que muestra la fecha/hora del último backup local
  const backupLabel = lastBackupAt
    ? `Último backup local: ${new Date(lastBackupAt).toLocaleString("es-AR", {
        dateStyle: "short",
        timeStyle: "short",
      })}`
    : "Aún sin backup local";

  return (
    <header className="flex items-center justify-between px-4 py-3 bg-white border-b border-slate-200 sticky top-0 z-30">
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 rounded-2xl bg-gradient-to-br from-sky-500 to-indigo-600 text-white grid place-items-center shadow-sm">
          <span className="text-xs font-bold tracking-tight">DA</span>
        </div>
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-slate-900">
            DespensaApp
          </h1>
          <p className="text-xs text-slate-500">Panel de gestión diaria</p>
        </div>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <div className="flex flex-col items-end">
          <span className="px-2 py-1 rounded-xl bg-slate-100 text-slate-700 text-xs">
            {email}
          </span>
          <span className="text-[11px] text-slate-400 mt-0.5">
            {backupLabel}
          </span>
        </div>
        <button
          onClick={onLogout}
          className="px-3 py-1.5 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-50 transition"
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
    <div className="min-h-[60vh] grid place-items-center px-4 bg-slate-100">
      <form
        onSubmit={handle}
        className="bg-white border border-slate-200 rounded-2xl p-6 w-full max-w-md shadow-sm"
      >
        <h1 className="text-2xl font-semibold mb-2 text-slate-900">
          Ingresar a DespensaApp
        </h1>
        <p className="text-sm text-slate-600 mb-4">
          Por ahora solo pedimos tu email (MVP). Más adelante agregamos
          verificación.
        </p>
        <label className="block text-sm text-slate-700 mb-1">Email</label>
        <input
          autoFocus
          className="w-full border rounded-xl px-3 py-2 mb-4 focus:outline-none focus:ring focus:ring-sky-200"
          placeholder="tucorreo@ejemplo.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
        />
        <button className="w-full bg-sky-600 text-white rounded-xl py-2 hover:bg-sky-700 transition font-medium">
          Entrar
        </button>
      </form>
    </div>
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
      productos: s.productos.map((p) =>
        p.id === id ? { ...p, nombre } : p
      ),
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

  const generateLabels = () => {
    const selected = data.productos.filter((p) => selectedIds.includes(p.id));
    if (!selected.length) {
      alert("Selecciona al menos un producto para generar etiquetas.");
      return;
    }

    const w = window.open("", "_blank");
    if (!w) {
      alert(
        "No se pudo abrir la ventana de impresión. Revisa el bloqueador de ventanas emergentes."
      );
      return;
    }

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
        <title>Etiquetas de precios</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 16px;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .labels {
            display: flex;
            flex-wrap: wrap;
            gap: 12px;
          }
          .label {
            width: 180px;
            height: 110px;
            border: 2px solid #111827;
            border-radius: 10px;
            padding: 8px 10px;
            display: flex;
            flex-direction: column;
            justify-content: space-between;
          }
          .label-name {
            font-size: 12px;
            font-weight: 600;
            color: #111827;
            line-height: 1.2;
          }
          .label-price {
            font-size: 26px;
            font-weight: 800;
            text-align: center;
            color: #111827;
            margin-top: 6px;
          }
          .label-ean {
            font-size: 10px;
            color: #4b5563;
            text-align: right;
          }
          @page {
            margin: 10mm;
          }
        </style>
      </head>
      <body onload="window.print()">
        <div class="labels">
          ${labelsHtml}
        </div>
      </body>
      </html>
    `;

    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  const exportProductos = () => {
    const rows = [
      ["ean", "nombre", "precio"],
      ...data.productos.map((p) => [
        p.ean,
        p.nombre,
        p.precio != null ? p.precio : 0,
      ]),
    ];
    const csv = rows
      .map((r) =>
        r
          .map((v) => `"${String(v).replace(/"/g, '""')}"`)
          .join(",")
      )
      .join("\n");
    download(
      `productos-${new Date().toISOString().slice(0, 10)}.csv`,
      csv
    );
  };

  return (
    <Section
      title="Productos"
      desc="Busca por código o nombre. Edita nombres y precios haciendo clic en el valor. No permite EAN duplicados."
      right={
        <div className="flex flex-wrap gap-2 justify-end">
          <button
            onClick={addManual}
            className="px-3 py-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-sm"
          >
            + Agregar
          </button>
          <button
            onClick={generateLabels}
            className="px-3 py-1.5 rounded-xl border border-sky-400 text-sky-700 bg-sky-50 hover:bg-sky-100 text-sm"
          >
            Etiquetas (PDF)
          </button>
          <button
            onClick={exportProductos}
            className="px-3 py-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-sm"
          >
            Exportar productos (CSV)
          </button>
          <button
            onClick={removeSelected}
            disabled={!selectedIds.length}
            className={
              "px-3 py-1.5 rounded-xl border text-sm " +
              (selectedIds.length
                ? "border-red-400 text-red-700 bg-red-50 hover:bg-red-100"
                : "border-slate-200 text-slate-400 bg-slate-100 cursor-not-allowed")
            }
          >
            Eliminar seleccionados
          </button>
        </div>
      }
    >
      <div className="flex items-center gap-3 mb-3">
        <input
          placeholder="Buscar por código o nombre..."
          className="flex-1 border rounded-xl px-3 py-2"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="text-sm text-slate-500">
          {results.length} / {data.productos.length}
        </span>
      </div>
      <div className="overflow-auto max-h-[50vh] border rounded-2xl bg-slate-50/40">
        <table className="w-full text-sm min-w-[900px]">
          <thead className="bg-slate-100 sticky top-0">
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
              <th className="text-right p-2">Precio PedidosYa</th>
              <th className="text-right p-2">Precio Rappi</th>
              <th className="text-right p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {results.map((p) => (
              <tr key={p.id} className="odd:bg-white even:bg-slate-50">
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
                    onChange={(v) => updateNombre(p.id, v)}
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
                    className="text-red-600 hover:underline text-xs"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
            {!results.length && (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-500">
                  Sin resultados
                </td>
              </tr>
            )}
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
        className="px-2 py-1 rounded-lg hover:bg-slate-100 font-medium"
      >
        {currency(value)}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <input
        autoFocus
        className="w-28 border rounded-lg px-2 py-1 text-right"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <button onClick={commit} className="text-sky-600 hover:underline">
        Guardar
      </button>
    </span>
  );
}

function InlineText({ value, onChange }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(value || ""));
  useEffect(() => setVal(String(value || "")), [value]);
  const commit = () => {
    const trimmed = val.trim();
    if (!trimmed) {
      alert("El nombre no puede estar vacío.");
      return;
    }
    onChange(trimmed);
    setEditing(false);
  };
  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="px-2 py-1 rounded-lg hover:bg-slate-100 text-left w-full"
      >
        {value || "(sin nombre)"}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 w-full">
      <input
        autoFocus
        className="flex-1 border rounded-lg px-2 py-1"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && commit()}
      />
      <button
        onClick={commit}
        className="text-sky-600 hover:underline text-xs"
      >
        Guardar
      </button>
    </span>
  );
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
          className="px-3 py-1.5 rounded-xl border hover:bg-slate-50 text-sm"
        >
          ↓ Plantilla CSV
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
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
            className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-sm"
          >
            Importar CSV
          </button>
          <button
            onClick={exportJSON}
            className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-sm"
          >
            Exportar respaldo (JSON)
          </button>
        </div>
        <p className="text-sm text-slate-600">
          Formato esperado: <code>ean,nombre,precio</code>. Ejemplo:{" "}
          <code className="ml-1">7790001000012,Leche entera 1L,1899</code>
        </p>
      </div>
    </Section>
  );
}

// ---- Nueva venta (incluye Fiado + multipago con restante) ----
function NuevaVenta({ data, setData }) {
  const [codigo, setCodigo] = useState("");
  const [items, setItems] = useState([]); // {id, ean, nombre, precio, qty}
  const [metodo, setMetodo] = useState("efectivo");

  // Multipago
  const [multiPago, setMultiPago] = useState(false);
  const [pagosTemp, setPagosTemp] = useState([]); // {id, metodo, monto}
  const [nuevoMetodoPago, setNuevoMetodoPago] = useState("efectivo");
  const [nuevoMontoPago, setNuevoMontoPago] = useState("");

  useEffect(() => {
    if (metodo === "fiado") {
      setMultiPago(false);
      setPagosTemp([]);
    }
  }, [metodo]);

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

    // Precio 0 → pedir manual (sin actualizar catálogo)
    if (!precio || +precio === 0) {
      let manual = null;
      while (manual === null) {
        const input = prompt(
          `El producto "${prod.nombre}" tiene precio 0.\n\nIngresa el precio (hasta 10 dígitos, sin símbolo $):`,
          ""
        );
        if (input === null) {
          return;
        }
        const cleaned = input.replace(/[^\d.,]/g, "");
        const digits = cleaned.replace(/\D/g, "");
        if (!digits) {
          alert("Ingresa un número válido.");
          continue;
        }
        if (digits.length > 10) {
          alert("Máximo 10 dígitos para el precio.");
          continue;
        }
        const num = parseFloat(
          cleaned.replace(/\./g, "").replace(",", ".")
        );
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

  const totalPagosTemp = useMemo(
    () => pagosTemp.reduce((a, p) => a + (p.monto || 0), 0),
    [pagosTemp]
  );

  const restante = useMemo(
    () => Math.max(0, total - totalPagosTemp),
    [total, totalPagosTemp]
  );

  const setQty = (id, qty) => {
    setItems((arr) =>
      arr.map((i) => (i.id === id ? { ...i, qty: Math.max(1, qty) } : i))
    );
  };

  const remove = (id) =>
    setItems((arr) => arr.filter((i) => i.id !== id));

  const agregarPagoTemp = () => {
    const monto = parseMoneyInput(nuevoMontoPago);
    if (!isFinite(monto) || monto <= 0) {
      alert("Ingresa un monto válido para el pago.");
      return;
    }
    setPagosTemp((arr) => [
      ...arr,
      { id: uid(), metodo: nuevoMetodoPago, monto },
    ]);
    setNuevoMontoPago("");
  };

  const quitarPagoTemp = (id) => {
    setPagosTemp((arr) => arr.filter((p) => p.id !== id));
  };

  const finalizar = () => {
    if (!items.length) return alert("Agrega artículos a la venta.");
    for (const it of items) {
      if (!isFinite(+it.precio) || +it.precio < 0) {
        alert("Revisa los precios ingresados (no pueden ser negativos).");
        return;
      }
    }

    const ahora = new Date().toISOString();

    // ---- FIADO (corregido, sin duplicar) ----
    if (metodo === "fiado") {
      const nombre = (
        prompt("¿A nombre de quién queda registrado el fiado?") || ""
      ).trim();
      if (!nombre) {
        alert("Debes indicar un nombre para registrar el fiado.");
        return;
      }

      const cargoItems = items.map((i) => {
        const prod = data.productos.find((p) => p.ean === i.ean);
        const prodPrecio = prod ? Number(prod.precio) || 0 : 0;

        if (prodPrecio === 0) {
          return {
            ean: i.ean,
            qty: i.qty,
            precioUnitario: i.precio, // se congela este precio
          };
        }

        return { ean: i.ean, qty: i.qty };
      });

      const cargo = {
        id: uid(),
        fecha: ahora,
        items: cargoItems,
      };

      setData((s) => {
        const actuales = s.fiados || [];
        const idx = actuales.findIndex(
          (p) => p.nombre.toLowerCase() === nombre.toLowerCase()
        );
        let fiadosActualizados;

        if (idx === -1) {
          fiadosActualizados = [
            ...actuales,
            { id: uid(), nombre, cargos: [cargo], abonos: [] },
          ];
        } else {
          const persona = actuales[idx];
          const personaActualizada = {
            ...persona,
            cargos: [cargo, ...(persona.cargos || [])],
          };
          fiadosActualizados = [...actuales];
          fiadosActualizados[idx] = personaActualizada;
        }

        return { ...s, fiados: fiadosActualizados };
      });

      setItems([]);
      alert(`Venta fiada registrada a nombre de: ${nombre}`);
      return;
    }

    // Venta normal (no fiado) → va a "ventas"
    let venta = null;

    if (multiPago) {
      if (!pagosTemp.length) {
        alert("Agrega al menos un método de pago.");
        return;
      }
      const totalPagos = pagosTemp.reduce(
        (a, p) => a + (p.monto || 0),
        0
      );
      const diff = Math.abs(totalPagos - total);
      if (diff > 0.01) {
        alert(
          `La suma de los métodos de pago (${currency(
            totalPagos
          )}) no coincide con el total de la venta (${currency(total)}).`
        );
        return;
      }
      const pagos = pagosTemp.map(({ id, ...rest }) => rest);
      venta = {
        id: uid(),
        fecha: ahora,
        items,
        metodo: "mixto",
        total,
        pagos,
      };
    } else {
      venta = {
        id: uid(),
        fecha: ahora,
        items,
        metodo,
        total,
        pagos: [{ metodo, monto: total }],
      };
    }

    setData((s) => ({ ...s, ventas: [venta, ...s.ventas] }));
    setItems([]);
    setPagosTemp([]);
    setMultiPago(false);
    setNuevoMontoPago("");
    alert("Venta registrada ✅");
  };

  return (
    <div className="grid md:grid-cols-3 gap-4">
      <div className="md:col-span-2">
        <Section
          title="Nueva venta"
          desc="Escanea o ingresa el código EAN del artículo. El código puede ser numérico o una palabra (no distingue mayúsculas/minúsculas)."
        >
          <div className="flex items-center gap-2 mb-3">
            <input
              placeholder="Código EAN o palabra"
              className="flex-1 border rounded-xl px-3 py-2 font-mono"
              value={codigo}
              onChange={(e) => setCodigo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addByCode()}
            />
            <button
              onClick={addByCode}
              className="px-3 py-2 rounded-xl border border-slate-300 hover:bg-slate-50 text-sm"
            >
              Agregar
            </button>
          </div>
          <div className="overflow-auto max-h-[40vh] border rounded-2xl bg-slate-50/40">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 sticky top-0">
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
                  <tr key={i.id} className="odd:bg-white even:bg-slate-50">
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
                        className="text-red-600 hover:underline text-xs"
                      >
                        Quitar
                      </button>
                    </td>
                  </tr>
                ))}
                {!items.length && (
                  <tr>
                    <td
                      colSpan={6}
                      className="p-6 text-center text-slate-500"
                    >
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
        <Section
          title="Resumen"
          desc="Selecciona el método de pago. Si es Fiado, se registrará la deuda por persona."
        >
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 border rounded-xl p-2 text-xs md:text-sm">
                <input
                  type="radio"
                  name="metodo"
                  checked={metodo === "efectivo"}
                  onChange={() => setMetodo("efectivo")}
                />
                Efectivo
              </label>
              <label className="flex items-center gap-2 border rounded-xl p-2 text-xs md:text-sm">
                <input
                  type="radio"
                  name="metodo"
                  checked={metodo === "mercadopago"}
                  onChange={() => setMetodo("mercadopago")}
                />
                MercadoPago
              </label>
              <label className="flex items-center gap-2 border rounded-xl p-2 text-xs md:text-sm">
                <input
                  type="radio"
                  name="metodo"
                  checked={metodo === "posnet"}
                  onChange={() => setMetodo("posnet")}
                />
                Posnet
              </label>
              <label className="flex items-center gap-2 border rounded-xl p-2 text-xs md:text-sm">
                <input
                  type="radio"
                  name="metodo"
                  checked={metodo === "fiado"}
                  onChange={() => setMetodo("fiado")}
                />
                Fiado
              </label>
            </div>

            {metodo !== "fiado" && (
              <div className="flex items-center justify-between mt-2">
                <label className="flex items-center gap-2 text-xs md:text-sm">
                  <input
                    type="checkbox"
                    checked={multiPago}
                    onChange={(e) => {
                      setMultiPago(e.target.checked);
                      setPagosTemp([]);
                    }}
                  />
                  <span>Venta con múltiples métodos de pago</span>
                </label>
              </div>
            )}

            {multiPago && metodo !== "fiado" && (
              <div className="mt-2 space-y-2 border rounded-xl p-2 bg-slate-50">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="border rounded-xl px-3 py-1.5 text-xs md:text-sm"
                    value={nuevoMetodoPago}
                    onChange={(e) => setNuevoMetodoPago(e.target.value)}
                  >
                    <option value="efectivo">Efectivo</option>
                    <option value="mercadopago">MercadoPago</option>
                    <option value="posnet">Posnet</option>
                  </select>
                  <input
                    type="text"
                    className="border rounded-xl px-3 py-1.5 text-xs md:text-sm"
                    placeholder="Monto (ej: 1000,00)"
                    value={nuevoMontoPago}
                    onChange={(e) => setNuevoMontoPago(e.target.value)}
                  />
                  <button
                    onClick={agregarPagoTemp}
                    className="px-3 py-1.5 rounded-xl bg-sky-600 text-white text-xs md:text-sm hover:bg-sky-700"
                  >
                    Agregar
                  </button>
                </div>
                <div className="text-xs text-slate-600 space-y-0.5">
                  <div>
                    Total de la venta:{" "}
                    <span className="font-semibold">
                      {currency(total)}
                    </span>
                  </div>
                  <div>
                    Suma de métodos cargados:{" "}
                    <span className="font-semibold">
                      {currency(totalPagosTemp)}
                    </span>
                  </div>
                  <div>
                    Restante por pagar:{" "}
                    <span
                      className={
                        "font-semibold " +
                        (restante === 0
                          ? "text-emerald-600"
                          : "text-amber-600")
                      }
                    >
                      {currency(restante)}
                    </span>
                  </div>
                </div>
                {pagosTemp.length > 0 && (
                  <div className="space-y-1 text-xs">
                    {pagosTemp.map((p) => (
                      <div
                        key={p.id}
                        className="flex items-center justify-between bg-white rounded-lg px-2 py-1 border"
                      >
                        <span>
                          {p.metodo} · {currency(p.monto)}
                        </span>
                        <button
                          onClick={() => quitarPagoTemp(p.id)}
                          className="text-red-600 hover:underline"
                        >
                          Quitar
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex items-center justify-between text-lg font-semibold pt-1">
              <span>Total</span>
              <span>{currency(total)}</span>
            </div>
            <button
              onClick={finalizar}
              className="w-full bg-sky-600 text-white rounded-xl py-2 hover:bg-sky-700 disabled:opacity-50 text-sm md:text-base"
              disabled={!items.length}
            >
              {metodo === "fiado"
                ? "Registrar fiado"
                : "Registrar venta"}
            </button>
          </div>
        </Section>
        <VentasRecientes data={data} setData={setData} />
      </div>
    </div>
  );
}

// ---- Ventas recientes ----
function VentasRecientes({ data, setData }) {
  const cierres = data.cierres || {};

  const eliminarVenta = (id) => {
    const venta = data.ventas.find((v) => v.id === id);
    if (
      venta &&
      venta.cierreFecha &&
      cierres[venta.cierreFecha] &&
      cierres[venta.cierreFecha].cerrado
    ) {
      alert(
        "Esta venta pertenece a un día ya cerrado y no puede eliminarse."
      );
      return;
    }

    if (!confirm("¿Eliminar esta venta?")) return;
    setData((s) => ({
      ...s,
      ventas: s.ventas.filter((v) => v.id !== id),
    }));
  };

  const actualizarMetodo = (id, metodo) => {
    const venta = data.ventas.find((v) => v.id === id);
    if (!venta) return;

    if (
      venta.cierreFecha &&
      cierres[venta.cierreFecha] &&
      cierres[venta.cierreFecha].cerrado
    ) {
      alert(
        "Esta venta pertenece a un día ya cerrado y no puede modificarse."
      );
      return;
    }

    if (Array.isArray(venta.pagos) && venta.pagos.length > 1) {
      alert(
        "Esta venta tiene múltiples métodos de pago. Modifícala manualmente en el sistema (no editable desde aquí)."
      );
      return;
    }

    setData((s) => ({
      ...s,
      ventas: s.ventas.map((v) =>
        v.id === id
          ? {
              ...v,
              metodo,
              pagos:
                Array.isArray(v.pagos) && v.pagos.length === 1
                  ? [{ ...v.pagos[0], metodo }]
                  : v.pagos,
            }
          : v
      ),
    }));
  };

  return (
    <Section title="Ventas recientes">
      <div className="space-y-3 max-h-[30vh] overflow-auto pr-1">
        {data.ventas.length === 0 && (
          <p className="text-sm text-slate-500">
            Aún no hay ventas registradas (se muestran solo las que no son
            fiado).
          </p>
        )}
        {data.ventas.map((v) => {
          const bloqueada =
            v.cierreFecha &&
            cierres[v.cierreFecha] &&
            cierres[v.cierreFecha].cerrado;

          const esMultipago =
            Array.isArray(v.pagos) && v.pagos.length > 1;

          const totalVenta =
            Array.isArray(v.pagos) && v.pagos.length
              ? v.pagos.reduce((a, p) => a + (p.monto || 0), 0)
              : v.total;

          return (
            <div key={v.id} className="border rounded-xl p-3 bg-white">
              <div className="flex items-center justify-between text-sm text-slate-600 mb-2">
                <span>
                  {new Date(v.fecha).toLocaleString("es-AR", {
                    dateStyle: "short",
                    timeStyle: "short",
                  })}
                </span>
                {esMultipago ? (
                  <span className="px-2 py-1 rounded-full bg-sky-50 text-sky-700 text-xs">
                    Múltiples métodos
                  </span>
                ) : (
                  <select
                    className="border rounded-lg px-2 py-1 text-xs uppercase disabled:bg-slate-100 disabled:text-slate-400"
                    value={v.metodo}
                    onChange={(e) =>
                      actualizarMetodo(v.id, e.target.value)
                    }
                    disabled={bloqueada}
                  >
                    <option value="efectivo">efectivo</option>
                    <option value="mercadopago">mercadopago</option>
                    <option value="posnet">posnet</option>
                  </select>
                )}
              </div>
              <div className="text-sm">
                {v.items.map((i) => (
                  <div
                    key={i.id}
                    className="flex items-center justify-between"
                  >
                    <span className="truncate mr-2">
                      {i.nombre} x{i.qty}
                    </span>
                    <span>{currency(i.precio * i.qty)}</span>
                  </div>
                ))}
              </div>

              {Array.isArray(v.pagos) && v.pagos.length > 0 && (
                <div className="mt-2 text-xs text-slate-600">
                  Métodos:{" "}
                  {v.pagos
                    .map(
                      (p) => `${p.metodo} ${currency(p.monto || 0)}`
                    )
                    .join(" · ")}
                </div>
              )}

              <div className="flex items-center justify-between mt-2 font-semibold">
                <span>Total</span>
                <span>{currency(totalVenta)}</span>
              </div>
              <div className="flex justify-between items-center mt-2">
                <button
                  onClick={() => eliminarVenta(v.id)}
                  disabled={bloqueada}
                  className={
                    "text-xs " +
                    (bloqueada
                      ? "text-slate-400 cursor-not-allowed"
                      : "text-red-600 hover:underline")
                  }
                >
                  Eliminar venta
                </button>
                {bloqueada && (
                  <span className="text-[11px] text-slate-500">
                    Bloqueada por cierre definitivo
                  </span>
                )}
              </div>
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

    if (!nombreProveedor) {
      alert("Ingresa el proveedor");
      return;
    }

    // No aceptamos 0 nunca
    if (!isFinite(n) || n === 0) {
      alert("Ingresa un monto distinto de 0");
      return;
    }

    // Para GASTO el monto debe ser positivo
    if (tipo === "gasto" && n < 0) {
      alert(
        'Para un "Gasto" el monto debe ser positivo. Si querés registrar una nota de crédito usá tipo "Compra" con monto negativo.'
      );
      return;
    }

    const item = {
      id: uid(),
      fecha: new Date().toISOString(),
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
        : [...proveedoresActuales, nombreProveedor].sort((a, b) =>
            a.localeCompare(b)
          );
      return { ...s, gastos, proveedores };
    });
    setProveedor("");
    setDescripcion("");
    setMonto("");
  };

  const eliminar = (id) => {
    if (!confirm("¿Eliminar este registro?")) return;
    setData((s) => {
      const gastosRestantes = (s.gastos || []).filter(
        (g) => g.id !== id
      );
      const proveedoresSet = new Set(
        gastosRestantes.map((g) => g.proveedor)
      );
      const proveedores = Array.from(proveedoresSet).sort((a, b) =>
        a.localeCompare(b)
      );
      return {
        ...s,
        gastos: gastosRestantes,
        proveedores,
      };
    });
  };

  const proveedores = data.proveedores || [];
  const registros = data.gastos || [];

  return (
    <Section
      title="Compras y gastos"
      desc="Registra compras y gastos diarios usando tu lista de proveedores."
      right={
        <button
          onClick={agregar}
          className="px-3 py-1.5 rounded-xl border border-slate-300 hover:bg-slate-50 text-sm"
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
          <span className="text-xs text-slate-500 mt-1">
            Escribe para buscar y seleccionar un proveedor guardado.
          </span>
        </div>
        <input
          className="border rounded-xl px-3 py-2"
          placeholder="Descripción (opcional)"
          value={descripcion}
          onChange={(e) => setDescripcion(e.target.value)}
        />
        <div className="flex flex-col">
          <input
            type="text"
            className="border rounded-xl px-3 py-2"
            placeholder="Monto (ej: 1234,50)"
            value={monto}
            onChange={(e) => setMonto(e.target.value)}
          />
          <span className="text-xs text-slate-500 mt-1">
            Para una nota de crédito, seleccioná tipo "Compra" y usa un monto negativo.
          </span>
        </div>
      </div>

      <div className="overflow-auto max-h-[50vh] border rounded-2xl bg-slate-50/40">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 sticky top-0">
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
              <tr key={g.id} className="odd:bg-white even:bg-slate-50">
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
                    className="text-red-600 hover:underline text-xs"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
            {!registros.length && (
              <tr>
                <td colSpan={6} className="p-6 text-center text-slate-500">
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

// ---- Cierre diario ----
function CierreDiario({ data, setData }) {
  const todayISO = new Date().toISOString().slice(0, 10);
  const [fecha, setFecha] = useState(todayISO);
  const [efectivoCajaProxDia, setEfectivoCajaProxDia] = useState("");
  const [efectivoPedidosYa, setEfectivoPedidosYa] = useState("");

  const [showEfectivoHelper, setShowEfectivoHelper] = useState(false);
  const [efectivoHelperItems, setEfectivoHelperItems] = useState([]);
  const [efectivoHelperMonto, setEfectivoHelperMonto] = useState("");

  const cierres = data.cierres || {};
  const cerrado = !!(cierres[fecha] && cierres[fecha].cerrado);

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

  const helperTotal = useMemo(
    () =>
      efectivoHelperItems.reduce((a, item) => a + (item.monto || 0), 0),
    [efectivoHelperItems]
  );

  const agregarHelperItem = () => {
    const monto = parseMoneyInput(efectivoHelperMonto);
    if (!isFinite(monto) || monto <= 0) {
      alert("Ingresa un monto válido.");
      return;
    }
    setEfectivoHelperItems((arr) => [
      ...arr,
      { id: uid(), monto },
    ]);
    setEfectivoHelperMonto("");
  };

  const limpiarHelper = () => {
    setEfectivoHelperItems([]);
    setEfectivoHelperMonto("");
  };

  const usarHelperTotal = () => {
    const total = helperTotal;
    const str = String(total).replace(".", ",");
    setEfectivoCajaProxDia(str);
    if (!cerrado) {
      updateCierreValue("efectivoCajaProxDia", str);
    }
    setShowEfectivoHelper(false);
  };

  const resumen = useMemo(() => {
    const ventas = data.ventas || [];
    const gastos = data.gastos || [];

    const ventasAsignadas = ventas.filter(
      (v) => v.cierreFecha === fecha
    );
    const ventasSinAsignar = ventas.filter((v) => !v.cierreFecha);

    const ventasDia = cerrado
      ? ventasAsignadas
      : [...ventasAsignadas, ...ventasSinAsignar];

    const d0 = new Date(fecha + "T00:00:00").getTime();
    const d1 = new Date(fecha + "T23:59:59.999").getTime();

    const gastosDia = (gastos || []).filter((g) => {
      const t = new Date(g.fecha).getTime();
      return t >= d0 && t <= d1;
    });

    const sumVentas = (metodo) =>
      ventasDia.reduce((a, v) => {
        if (Array.isArray(v.pagos) && v.pagos.length) {
          return (
            a +
            v.pagos
              .filter((p) => p.metodo === metodo)
              .reduce((x, p) => x + (p.monto || 0), 0)
          );
        }
        return a + (v.metodo === metodo ? (v.total || 0) : 0);
      }, 0);

    const totalVentas = ventasDia.reduce((a, v) => {
      if (Array.isArray(v.pagos) && v.pagos.length) {
        return (
          a +
          v.pagos.reduce((x, p) => x + (p.monto || 0), 0)
        );
      }
      return a + (v.total || 0);
    }, 0);

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
  }, [data.ventas, data.gastos, fecha, cerrado]);

  const prevDateStr = useMemo(() => {
    const d = new Date(fecha + "T00:00:00");
    d.setDate(d.getDate() - 1);
    return d.toISOString().slice(0, 10);
  }, [fecha]);

  const dineroCajaDiaAnterior = parseMoneyInput(
    (cierres[prevDateStr] && cierres[prevDateStr].efectivoCajaProxDia) ||
      0
  );

  const efectivoCajaNum = parseMoneyInput(efectivoCajaProxDia);
  const efectivoPedidosYaNum = parseMoneyInput(efectivoPedidosYa);

  const efectivoTotalDisponible =
    resumen.porMetodo.efectivo +
    dineroCajaDiaAnterior +
    efectivoPedidosYaNum -
    efectivoCajaNum;

  const updateCierreValue = (field, rawValue) => {
    const num = parseMoneyInput(rawValue);
    setData((s) => {
      const oldCierres = s.cierres || {};
      const prev = oldCierres[fecha] || {};
      return {
        ...s,
        cierres: {
          ...oldCierres,
          [fecha]: {
            ...prev,
            [field]: num,
            cerrado: prev.cerrado || false,
          },
        },
      };
    });
  };

  const onChangeCajaProxDia = (value) => {
    setEfectivoCajaProxDia(value);
    if (!cerrado) updateCierreValue("efectivoCajaProxDia", value);
  };

  const onChangePedidosYa = (value) => {
    setEfectivoPedidosYa(value);
    if (!cerrado) updateCierreValue("efectivoPedidosYa", value);
  };

  const cerrarDefinitivo = () => {
    if (
      !confirm(
        "¿Confirmar cierre definitivo del día? Luego no se podrán editar los campos de efectivo y las ventas de este período quedarán bloqueadas."
      )
    )
      return;
    const caja = efectivoCajaNum;
    const pedYa = efectivoPedidosYaNum;
    setData((s) => {
      const oldCierres = s.cierres || {};
      const prev = oldCierres[fecha] || {};
      const cierresNuevos = {
        ...oldCierres,
        [fecha]: {
          ...prev,
          efectivoCajaProxDia: caja,
          efectivoPedidosYa: pedYa,
          cerrado: true,
        },
      };

      const ventasConCierre = (s.ventas || []).map((v) =>
        v.cierreFecha ? v : { ...v, cierreFecha: v.cierreFecha || fecha }
      );

      return {
        ...s,
        cierres: cierresNuevos,
        ventas: ventasConCierre,
      };
    });
    alert(
      "Cierre definitivo guardado. Día bloqueado para edición de efectivo y ventas."
    );
  };

  const reabrirDia = () => {
    if (!cerrado) return;
    if (
      !confirm(
        "¿Reabrir el cierre de este día? Podrás editar el efectivo y las ventas volverán a quedar abiertas."
      )
    )
      return;

    setData((s) => {
      const oldCierres = s.cierres || {};
      const prev = oldCierres[fecha] || {};
      const cierresNuevos = {
        ...oldCierres,
        [fecha]: {
          ...prev,
          cerrado: false,
        },
      };

      const ventasReabiertas = (s.ventas || []).map((v) =>
        v.cierreFecha === fecha ? { ...v, cierreFecha: undefined } : v
      );

      return {
        ...s,
        cierres: cierresNuevos,
        ventas: ventasReabiertas,
      };
    });

    alert("Día reabierto. Ahora puedes seguir registrando ventas y editar el efectivo.");
  };

  return (
    <Section
      title="Cierre diario"
      desc="Totales por método, compras, gastos y campos editables para efectivo en caja y PedidosYa."
      right={
        <div className="flex flex-wrap gap-2 justify-end">
          {cerrado && (
            <button
              onClick={reabrirDia}
              className="px-3 py-1.5 rounded-xl border text-xs md:text-sm bg-amber-50 border-amber-400 text-amber-800 hover:bg-amber-100"
            >
              Reabrir día
            </button>
          )}
          <button
            onClick={cerrarDefinitivo}
            disabled={cerrado}
            className={
              "px-3 py-1.5 rounded-xl border text-xs md:text-sm " +
              (cerrado
                ? "bg-slate-200 text-slate-500 cursor-not-allowed"
                : "bg-red-50 border-red-400 text-red-700 hover:bg-red-100")
            }
          >
            {cerrado ? "Día cerrado" : "Cierre definitivo del día"}
          </button>
          <button
            onClick={() => window.print()}
            className="px-3 py-1.5 rounded-xl border hover:bg-slate-50 text-xs md:text-sm"
          >
            Imprimir / PDF
          </button>
        </div>
      }
    >
      <div className="flex items-center gap-3 mb-4">
        <label className="text-sm text-slate-700">Fecha</label>
        <input
          type="date"
          className="border rounded-xl px-3 py-2"
          value={fecha}
          onChange={(e) => setFecha(e.target.value)}
        />
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
          label="Total ventas del día"
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
          label="Neto del día (ventas - compras - gastos)"
          value={currency(resumen.netoDia)}
          variant="primary"
        />
      </div>

      <div className="grid md:grid-cols-4 gap-3 mb-6">
        <CardStat
          label="Dinero en caja (día anterior)"
          value={currency(dineroCajaDiaAnterior)}
        />
        <CardStat
          label="Efectivo Total Disponible"
          value={currency(efectivoTotalDisponible)}
          variant="accent"
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <div className="border rounded-2xl p-4 bg-white">
          <label className="block text-sm text-slate-700 mb-1">
            Efectivo en caja para próximo día
          </label>
          <div className="flex items-center gap-2 mb-2">
            <span className="text-slate-500">$</span>
            <input
              type="text"
              className="flex-1 border rounded-xl px-3 py-2"
              placeholder="$ 0,00"
              value={efectivoCajaProxDia}
              onChange={(e) => onChangeCajaProxDia(e.target.value)}
              disabled={cerrado}
            />
            <button
              type="button"
              onClick={() => setShowEfectivoHelper((v) => !v)}
              className="px-2 py-1.5 rounded-xl border text-xs hover:bg-slate-50"
              disabled={cerrado}
            >
              Contar efectivo
            </button>
          </div>
          <div className="text-xs text-slate-500">
            Valor formateado:{" "}
            <span className="font-medium">{currency(efectivoCajaNum)}</span>
          </div>

          {showEfectivoHelper && !cerrado && (
            <div className="mt-3 border rounded-xl p-3 bg-slate-50 space-y-2">
              <div className="text-xs font-semibold text-slate-700 mb-1">
                Sumar efectivo contado
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  className="flex-1 border rounded-xl px-2 py-1 text-xs"
                  placeholder="Monto parcial (ej: 2000,00)"
                  value={efectivoHelperMonto}
                  onChange={(e) =>
                    setEfectivoHelperMonto(e.target.value)
                  }
                />
                <button
                  type="button"
                  onClick={agregarHelperItem}
                  className="px-2.5 py-1.5 rounded-xl bg-sky-600 text-white text-xs hover:bg-sky-700"
                >
                  Sumar
                </button>
                <button
                  type="button"
                  onClick={limpiarHelper}
                  className="px-2.5 py-1.5 rounded-xl border text-xs hover:bg-slate-100"
                >
                  Limpiar
                </button>
              </div>
              {efectivoHelperItems.length > 0 && (
                <div className="max-h-28 overflow-auto text-xs space-y-1">
                  {efectivoHelperItems.map((it) => (
                    <div
                      key={it.id}
                      className="flex justify-between items-center bg-white rounded-lg border px-2 py-1"
                    >
                      <span>Parcial: {currency(it.monto)}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="text-xs text-slate-700">
                Total contado:{" "}
                <span className="font-semibold">
                  {currency(helperTotal)}
                </span>
              </div>
              <button
                type="button"
                onClick={usarHelperTotal}
                className="w-full mt-1 px-2.5 py-1.5 rounded-xl bg-emerald-600 text-white text-xs hover:bg-emerald-700"
              >
                Usar total como efectivo en caja
              </button>
            </div>
          )}
        </div>
        <div className="border rounded-2xl p-4 bg-white">
          <label className="block text-sm text-slate-700 mb-1">
            Efectivo de PedidosYa
          </label>
          <div className="flex items-center gap-2">
            <span className="text-slate-500">$</span>
            <input
              type="text"
              className="flex-1 border rounded-xl px-3 py-2"
              placeholder="$ 0,00"
              value={efectivoPedidosYa}
              onChange={(e) => onChangePedidosYa(e.target.value)}
              disabled={cerrado}
            />
          </div>
          <div className="text-xs text-slate-500 mt-1">
            Valor formateado:{" "}
            <span className="font-medium">
              {currency(efectivoPedidosYaNum)}
            </span>
          </div>
        </div>
      </div>

      <h3 className="text-sm font-semibold text-slate-700 mb-2">
        Ventas del día (según cierres)
      </h3>
      <div className="overflow-auto max-h-[40vh] border rounded-2xl mb-6 bg-slate-50/40">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 sticky top-0">
            <tr>
              <th className="text-left p-2">Hora</th>
              <th className="text-left p-2">Método</th>
              <th className="text-right p-2">Total</th>
            </tr>
          </thead>
          <tbody>
            {resumen.ventasDia.map((v) => {
              const totalVenta =
                Array.isArray(v.pagos) && v.pagos.length
                  ? v.pagos.reduce(
                      (a, p) => a + (p.monto || 0),
                      0
                    )
                  : v.total;
              return (
                <tr
                  key={v.id}
                  className="odd:bg-white even:bg-slate-50"
                >
                  <td className="p-2">
                    {new Date(v.fecha).toLocaleTimeString("es-AR", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </td>
                  <td className="p-2 uppercase">
                    {Array.isArray(v.pagos) && v.pagos.length > 1
                      ? "mixto"
                      : v.metodo}
                  </td>
                  <td className="p-2 text-right">
                    {currency(totalVenta)}
                  </td>
                </tr>
              );
            })}
            {!resumen.ventasDia.length && (
              <tr>
                <td colSpan={3} className="p-6 text-center text-slate-500">
                  Sin ventas en esta fecha / cierre
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h3 className="text-sm font-semibold text-slate-700 mb-2">
        Compras y gastos del día
      </h3>
      <div className="overflow-auto max-h-[40vh] border rounded-2xl bg-slate-50/40">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 sticky top-0">
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
              <tr
                key={g.id}
                className="odd:bg-white even:bg-slate-50"
              >
                <td className="p-2">
                  {new Date(g.fecha).toLocaleTimeString("es-AR", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </td>
                <td className="p-2 capitalize">{g.tipo}</td>
                <td className="p-2">{g.proveedor}</td>
                <td className="p-2">{g.descripcion}</td>
                <td className="p-2 text-right">
                  {currency(g.monto)}
                </td>
              </tr>
            ))}
            {!resumen.gastosDia.length && (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  Sin compras ni gastos en esta fecha
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ---- Resumen histórico ----
function ResumenHistorico({ data }) {
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

    const totalVentas = ventasRango.reduce(
      (acc, v) => {
        if (Array.isArray(v.pagos) && v.pagos.length) {
          return (
            acc +
            v.pagos.reduce((x, p) => x + (p.monto || 0), 0)
          );
        }
        return acc + (v.total || 0);
      },
      0
    );

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
      alert("Configura un rango de fechas válido antes de exportar.");
      return;
    }

    const {
      totalVentas,
      totalCompras,
      totalGastos,
      totalGeneral,
      gastosRango,
    } = resumen;

    const totalVentasStr = currency(totalVentas);
    const totalComprasStr = currency(totalCompras);
    const totalGastosStr = currency(totalGastos);
    const totalGeneralStr = currency(totalGeneral);

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
    if (!w) {
      alert(
        "No se pudo abrir la ventana de impresión. Revisa el bloqueador de ventanas emergentes."
      );
      return;
    }

    const titulo = "Resumen histórico";

    const html = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="utf-8" />
        <title>${escapeHtml(titulo)}</title>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            padding: 16px 24px;
            font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            font-size: 12px;
          }
          h1 {
            font-size: 20px;
            margin: 0 0 4px 0;
          }
          .range {
            font-size: 13px;
            color: #4b5563;
            margin-top: 2px;
            margin-bottom: 16px;
          }
          .grid {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 8px;
            margin-bottom: 18px;
          }
          .card {
            border-radius: 10px;
            border: 1px solid #e5e7eb;
            padding: 8px 10px;
            background: #f9fafb;
          }
          .card.primary {
            background: #eef2ff;
            border-color: #c7d2fe;
          }
          .card.accent {
            background: #ecfdf5;
            border-color: #6ee7b7;
          }
          .card-label {
            font-size: 11px;
            color: #6b7280;
            margin-bottom: 4px;
          }
          .card-value {
            font-size: 17px;
            font-weight: 600;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 8px;
          }
          th, td {
            border: 1px solid #e5e7eb;
            padding: 4px 6px;
          }
          th {
            background: #f3f4f6;
            font-size: 11px;
            text-align: left;
          }
          .section-title {
            font-size: 13px;
            font-weight: 600;
            margin-top: 16px;
          }
          @page {
            margin: 12mm;
          }
        </style>
      </head>
      <body onload="window.print()">
        <div>
          <h1>${escapeHtml(titulo)}</h1>
          <div class="range">Período: ${desde} a ${hasta}</div>
        </div>

        <div class="grid">
          <div class="card primary">
            <div class="card-label">Total ventas en el rango</div>
            <div class="card-value">${totalVentasStr}</div>
          </div>
          <div class="card primary">
            <div class="card-label">Total compras en el rango</div>
            <div class="card-value">${totalComprasStr}</div>
          </div>
          <div class="card primary">
            <div class="card-label">Total gastos en el rango</div>
            <div class="card-value">${totalGastosStr}</div>
          </div>
          <div class="card accent">
            <div class="card-label">Total general (ventas - compras - gastos)</div>
            <div class="card-value">${totalGeneralStr}</div>
          </div>
        </div>

        <div class="section-title">Detalle de compras y gastos</div>
        <table>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Hora</th>
              <th>Tipo</th>
              <th>Proveedor</th>
              <th>Descripción</th>
              <th style="text-align:right;">Monto</th>
            </tr>
          </thead>
          <tbody>
            ${
              rowsHtml ||
              `<tr><td colspan="6" style="text-align:center;color:#9ca3af;">No hay compras ni gastos en este rango.</td></tr>`
            }
          </tbody>
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
          className="px-3 py-1.5 rounded-xl border text-sm hover:bg-slate-50"
        >
          Imprimir / PDF
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-700">Desde</label>
          <input
            type="date"
            className="border rounded-xl px-3 py-2"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-slate-700">Hasta</label>
          <input
            type="date"
            className="border rounded-xl px-3 py-2"
            value={hasta}
            onChange={(e) => setHasta(e.target.value)}
          />
        </div>
      </div>

      {!valido && (
        <p className="text-sm text-red-600 mb-4">
          Verifica que ambas fechas estén completas y que “Desde” no sea mayor
          que “Hasta”.
        </p>
      )}

      {valido && resumen && (
        <>
          <div className="grid md:grid-cols-4 gap-3 mb-6">
            <CardStat
              label="Total ventas en el rango"
              value={currency(resumen.totalVentas)}
              variant="primary"
            />
            <CardStat
              label="Total compras en el rango"
              value={currency(resumen.totalCompras)}
              variant="primary"
            />
            <CardStat
              label="Total gastos en el rango"
              value={currency(resumen.totalGastos)}
              variant="primary"
            />
            <CardStat
              label="Total general (ventas - compras - gastos)"
              value={currency(resumen.totalGeneral)}
              variant="accent"
            />
          </div>

          <h3 className="text-sm font-semibold text-slate-700 mb-2">
            Compras y gastos en el rango
          </h3>
          <div className="overflow-auto max-h-[40vh] border rounded-2xl bg-slate-50/40">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 sticky top-0">
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
                  <tr
                    key={g.id}
                    className="odd:bg-white even:bg-slate-50"
                  >
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
                    <td className="p-2 text-right">
                      {currency(g.monto)}
                    </td>
                  </tr>
                ))}
                {!resumen.gastosRango.length && (
                  <tr>
                    <td
                      colSpan={6}
                      className="p-6 text-center text-slate-500"
                    >
                      No hay compras ni gastos en este rango.
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
            <label className="block text-sm font-medium mb-1">
              Desde
            </label>
            <input
              type="date"
              value={desde}
              onChange={(e) => setDesde(e.target.value)}
              className="border rounded-xl px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">
              Hasta
            </label>
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
            className="px-3 py-2 rounded-xl bg-sky-600 text-white text-sm disabled:opacity-50 hover:bg-sky-700"
          >
            {loading ? "Calculando..." : "Calcular"}
          </button>
        </div>

        {error && (
          <div className="text-red-600 text-sm">
            {error}
          </div>
        )}

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

            <div className="overflow-auto max-h-96 border rounded-2xl bg-slate-50/40">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 sticky top-0">
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
                      className="border-t odd:bg-white even:bg-slate-50"
                    >
                      <td className="px-2 py-1">{idx + 1}</td>
                      <td className="px-2 py-1">{p.ean}</td>
                      <td className="px-2 py-1">{p.nombre}</td>
                      <td className="px-2 py-1 text-right">
                        {p.cantidad}
                      </td>
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
                        className="px-2 py-4 text-center text-slate-500"
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
// ---- Fiados ----
// ---- Fiados ----
function Fiados({ data, setData }) {
  const personas = data.fiados || [];
  const productos = data.productos || [];

  const [abonoNombre, setAbonoNombre] = useState("");
  const [abonoMonto, setAbonoMonto] = useState("");
  const [abonoPassword, setAbonoPassword] = useState(""); // NUEVO: password abono

  // NUEVO: estado para eliminar un fiado con contraseña
  const [deleteTarget, setDeleteTarget] = useState(null); // persona a eliminar
  const [deletePassword, setDeletePassword] = useState("");

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

  const totalFiados = useMemo(
    () =>
      personasConSaldo.reduce(
        (acc, p) => acc + (p.saldo || 0),
        0
      ),
    [personasConSaldo]
  );

  const nombresFiados = personasConSaldo.map((p) => p.nombre);

  const agregarAbono = () => {
    const nombre = abonoNombre.trim();
    const monto = parseMoneyInput(abonoMonto);

    if (!nombre) {
      alert("Ingresa el nombre de la persona.");
      return;
    }
    if (!isFinite(monto) || monto <= 0) {
      alert("Ingresa un monto válido (> 0).");
      return;
    }
    const existe = personas.find(
      (p) => p.nombre.toLowerCase() === nombre.toLowerCase()
    );
    if (!existe) {
      alert("No se encontró esa persona en Fiados.");
      return;
    }

    // Validar contraseña con input type="password"
    const PASSWORD_ABONO = "19256436";
    if (!abonoPassword) {
      alert("Ingresa la contraseña para registrar el abono.");
      return;
    }
    if (abonoPassword !== PASSWORD_ABONO) {
      alert("Contraseña incorrecta. No se registró el abono.");
      return;
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

      // Eliminar personas cuyo saldo quede en 0
      fiados = fiados.filter(
        (p) => computeSaldoPersona(p, productosS) > 0.0001
      );

      return { ...s, fiados };
    });

    setAbonoNombre("");
    setAbonoMonto("");
    setAbonoPassword(""); // limpiar password tras éxito
    alert("Abono registrado.");
  };

  // MODAL eliminar fiado
  const abrirModalEliminar = (persona) => {
    setDeleteTarget(persona);
    setDeletePassword("");
  };

  const cerrarModalEliminar = () => {
    setDeleteTarget(null);
    setDeletePassword("");
  };

  const confirmarEliminarFiado = () => {
    const PASSWORD_ELIMINAR = "Cmarie1$";

    if (deletePassword !== PASSWORD_ELIMINAR) {
      alert("Contraseña incorrecta. No se eliminó el fiado.");
      return;
    }

    setData((s) => ({
      ...s,
      fiados: (s.fiados || []).filter(
        (p) => p.id !== (deleteTarget && deleteTarget.id)
      ),
    }));

    cerrarModalEliminar();
    alert("Fiado eliminado por completo.");
  };

  return (
    <Section
      title="Fiados"
      desc="Personas con deudas, detalle de compras fiadas y abonos. El saldo se recalcula automáticamente; para productos con precio 0 se usa el precio guardado en ese fiado."
    >
      <div className="grid md:grid-cols-3 gap-3 mb-4">
        <div className="flex flex-col gap-1 md:col-span-1">
          <label className="text-sm text-slate-700">
            Nombre de la persona (para abono)
          </label>
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
          <label className="text-sm text-slate-700">
            Importe del abono
          </label>
          <input
            type="text"
            className="border rounded-xl px-3 py-2"
            placeholder="Ej: 1500,00"
            value={abonoMonto}
            onChange={(e) => setAbonoMonto(e.target.value)}
          />
          <span className="text-xs text-slate-500">
            Se descontará del saldo acumulado de la persona. Requiere
            contraseña.
          </span>
        </div>

        <div className="flex flex-col gap-1 md:col-span-1">
          <label className="text-sm text-slate-700">
            Contraseña para registrar abono
          </label>
          <input
            type="password"
            className="border rounded-xl px-3 py-2"
            placeholder="Ingresa la contraseña"
            value={abonoPassword}
            onChange={(e) => setAbonoPassword(e.target.value)}
          />
          <button
            onClick={agregarAbono}
            className="w-full bg-sky-600 text-white rounded-xl py-2 hover:bg-sky-700 mt-2"
          >
            Agregar abono
          </button>
        </div>
      </div>

      <div className="mb-3 text-sm text-slate-700">
        Total fiados activos:{" "}
        <span className="font-semibold">
          {currency(totalFiados)}
        </span>
      </div>

      {personasConSaldo.length === 0 ? (
        <p className="text-sm text-slate-500">
          No hay fiados activos. Cuando registres ventas con el método de pago
          <strong> Fiado</strong>, aparecerán aquí.
        </p>
      ) : (
        <div className="space-y-4 max-h-[60vh] overflow-auto pr-1">
          {personasConSaldo.map((p) => {
            const cargos = p.cargos || [];
            const abonos = p.abonos || [];
            const mapProd = new Map(productos.map((pr) => [pr.ean, pr]));

            return (
              <div
                key={p.id}
                className="border rounded-2xl p-4 bg-white"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-lg font-semibold">{p.nombre}</h3>
                  <div className="flex flex-col items-end gap-1">
                    <span className="text-sm text-slate-600">
                      Saldo actual:{" "}
                      <span className="font-semibold">
                        {currency(p.saldo)}
                      </span>
                    </span>
                    <button
                      onClick={() => abrirModalEliminar(p)}
                      className="text-xs text-red-600 hover:underline"
                    >
                      Eliminar fiado
                    </button>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-700 mb-1">
                      Ventas fiadas
                    </h4>
                    <div className="border rounded-xl max-h-48 overflow-auto bg-slate-50/40">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-100 sticky top-0">
                          <tr>
                            <th className="text-left p-1.5">
                              Fecha
                            </th>
                            <th className="text-left p-1.5">
                              Detalle
                            </th>
                            <th className="text-right p-1.5">Monto</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cargos.map((c) => {
                            let totalCargo = 0;
                            const detalle = (c.items || []).map(
                              (it, idx) => {
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
                              }
                            );

                            return (
                              <tr
                                key={c.id}
                                className="odd:bg-white even:bg-slate-50 align-top"
                              >
                                <td className="p-1.5">
                                  {new Date(
                                    c.fecha
                                  ).toLocaleString("es-AR", {
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
                                className="p-3 text-center text-slate-400"
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
                    <h4 className="text-sm font-semibold text-slate-700 mb-1">
                      Abonos
                    </h4>
                    <div className="border rounded-xl max-h-48 overflow-auto bg-slate-50/40">
                      <table className="w-full text-xs">
                        <thead className="bg-slate-100 sticky top-0">
                          <tr>
                            <th className="text-left p-1.5">
                              Fecha
                            </th>
                            <th className="text-right p-1.5">
                              Monto
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {abonos.map((a) => (
                            <tr
                              key={a.id}
                              className="odd:bg-white even:bg-slate-50"
                            >
                              <td className="p-1.5">
                                {new Date(
                                  a.fecha
                                ).toLocaleString("es-AR", {
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
                                className="p-3 text-center text-slate-400"
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

      {/* MODAL para eliminar fiado con contraseña */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm p-5">
            <h3 className="text-lg font-semibold mb-2">
              Eliminar fiado
            </h3>
            <p className="text-sm text-slate-600 mb-3">
              Vas a eliminar por completo el fiado de{" "}
              <span className="font-semibold">
                {deleteTarget.nombre}
              </span>
              . Esta acción no se puede deshacer.
            </p>
            <p className="text-sm text-slate-600 mb-3">
              Saldo actual:{" "}
              <span className="font-semibold">
                {currency(
                  computeSaldoPersona(deleteTarget, productos)
                )}
              </span>
            </p>
            <label className="block text-sm text-slate-700 mb-1">
              Contraseña
            </label>
            <input
              type="password"
              className="w-full border rounded-xl px-3 py-2 mb-4"
              placeholder="Ingresa la contraseña"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={cerrarModalEliminar}
                className="px-3 py-1.5 rounded-xl border text-sm hover:bg-slate-50"
              >
                Cancelar
              </button>
              <button
                onClick={confirmarEliminarFiado}
                className="px-3 py-1.5 rounded-xl text-sm bg-red-600 text-white hover:bg-red-700"
              >
                Eliminar fiado
              </button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}

function CardStat({ label, value, variant = "normal" }) {
  const variantClasses =
    variant === "primary"
      ? "bg-sky-50 border-sky-300"
      : variant === "accent"
      ? "bg-emerald-50 border-emerald-300"
      : "bg-white border-slate-200";

  return (
    <div className={`border rounded-2xl p-4 ${variantClasses}`}>
      <div className="text-sm text-slate-600">{label}</div>
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
    <nav className="flex flex-wrap gap-2 p-2 bg-white border-b border-slate-200 sticky top-[57px] z-20">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={
            "px-3 py-1.5 rounded-full text-sm transition " +
            (tab === t.id
              ? "bg-slate-900 text-white shadow-sm"
              : "border border-slate-200 text-slate-700 hover:bg-slate-50")
          }
        >
          {t.label}
        </button>
      ))}
    </nav>
  );
}

// ---- App principal ----
export default function DespensaApp() {
  const [email, setEmail] = useState(
    localStorage.getItem("despensa:lastEmail") || ""
  );
  const [data, setData, lastBackupAt] = useUserStorage(email);
  const [tab, setTab] = useState("productos");

  useEffect(() => {
    if (email) localStorage.setItem("despensa:lastEmail", email);
  }, [email]);

  const logout = () => setEmail("");

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {email ? (
        <>
          <TopBar email={email} onLogout={logout} lastBackupAt={lastBackupAt} />
          <Nav tab={tab} setTab={setTab} />
          <main className="max-w-6xl mx-auto p-4 space-y-4">
            {tab === "productos" && (
              <Productos data={data} setData={setData} />
            )}
            {tab === "venta" && (
              <NuevaVenta data={data} setData={setData} />
            )}
            {tab === "gastos" && (
              <ComprasGastos data={data} setData={setData} />
            )}
            {tab === "fiados" && (
              <Fiados data={data} setData={setData} />
            )}
            {tab === "cierre" && (
              <CierreDiario data={data} setData={setData} />
            )}
            {tab === "ranking" && <RankingVentas email={email} />}
            {tab === "historico" && (
              <ResumenHistorico data={data} />
            )}
            {tab === "io" && (
              <ImportExport data={data} setData={setData} />
            )}
          </main>
        </>
      ) : (
        <Login onLogin={setEmail} />
      )}
      <footer className="text-center text-xs text-slate-400 py-6">
        DespensaApp v1.1 Datos Protegidos
      </footer>
    </div>
  );
}
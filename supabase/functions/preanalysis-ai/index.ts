import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = Deno.env.get("GEMINI_PREANALYSIS_MODEL") || "gemini-2.0-flash";
const GEMINI_FALLBACK_MODELS = Array.from(
  new Set([
    "gemini-2.0-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
    GEMINI_MODEL,
    "gemini-2.5-flash",
  ]),
);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type IncomingDocument = {
  fileName: string;
  mimeType: string;
  base64: string;
};

type GeminiPart = {
  text?: string;
  inlineData?: {
    mimeType: string;
    data: string;
  };
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function cleanBase64(value: string) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "").trim();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseGeminiErrorStatus(errorText: string) {
  try {
    const parsed = JSON.parse(errorText);
    const status = parsed?.error?.status || parsed?.status || "";
    const code = Number(parsed?.error?.code || parsed?.code || 0);
    return { status: String(status), code };
  } catch {
    return { status: "", code: 0 };
  }
}

function isTemporaryGeminiError(statusCode: number, errorText: string) {
  const parsed = parseGeminiErrorStatus(errorText);
  return (
    statusCode === 429 ||
    statusCode === 500 ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504 ||
    parsed.status === "UNAVAILABLE" ||
    parsed.status === "RESOURCE_EXHAUSTED"
  );
}

function isUnsupportedGeminiModel(statusCode: number, errorText: string) {
  const parsed = parseGeminiErrorStatus(errorText);
  return statusCode === 404 || parsed.status === "NOT_FOUND";
}

function userFriendlyGeminiError(errorText: string, fallback = "AI temporaneamente non disponibile") {
  const parsed = parseGeminiErrorStatus(errorText);
  if (parsed.status === "UNAVAILABLE" || parsed.code === 503) {
    return "Gemini è temporaneamente sovraccarico. Riprova tra qualche minuto oppure ricarica i documenti.";
  }
  if (parsed.status === "RESOURCE_EXHAUSTED" || parsed.code === 429) {
    return "Limite temporaneo Gemini raggiunto. Attendi qualche minuto e riprova.";
  }
  return fallback;
}

function normalizeMoney(value: unknown) {
  const raw = String(value || "").trim().replace(/\s/g, "").replace(/[^\d,.-]/g, "");
  if (!raw) return "";
  if (raw.includes(",")) return raw.replace(/\./g, "").replace(",", ".");
  return raw;
}

function normalizeDate(value: unknown) {
  const raw = String(value || "").trim();
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const italian = raw.match(/\b([0-3]?\d)[./-]([01]?\d)[./-]((?:20)?\d{2})\b/);
  if (!italian) return "";
  const day = italian[1].padStart(2, "0");
  const month = italian[2].padStart(2, "0");
  const year = italian[3].length === 2 ? `20${italian[3]}` : italian[3];
  return `${year}-${month}-${day}`;
}

function normalizeRows(value: unknown) {
  const data = value as { rows?: Array<Record<string, unknown>> };
  if (!Array.isArray(data?.rows)) return [];
  const rowsByFile = new Map<string, ReturnType<typeof normalizeSingleRow>>();
  for (const row of data.rows) {
    const normalized = normalizeSingleRow(row);
    const key = normalized.sourceFileName || `document-${rowsByFile.size + 1}`;
    const existing = rowsByFile.get(key);
    rowsByFile.set(key, existing ? mergeDuplicateDocumentRows(existing, normalized) : normalized);
  }
  return [...rowsByFile.values()];
}

function normalizeSingleRow(row: Record<string, unknown>) {
    const documentType = String(row.documentType || "").toUpperCase();
    const category = String(row.category || "");
    const supplier = String(row.supplier || "").trim();
    const taxableAmount = normalizeMoney(row.taxableAmount);
    return {
      sourceFileName: String(row.sourceFileName || ""),
      documentType: ["FATTURA", "PREVENTIVO", "PRO-FORMA"].includes(documentType) ? documentType : "PREVENTIVO",
      supplier,
      documentNumber: String(row.documentNumber || "").trim(),
      documentDate: normalizeDate(row.documentDate),
      taxableAmount,
      category: ["Impianti", "Macchinari", "Attrezzature", "Terreni/Immobili"].includes(category) ? category : "Macchinari",
      description: String(row.description || "").trim().slice(0, 260),
      confidence: Math.max(0, Math.min(1, Number(row.confidence || 0))),
      needsReview: Boolean(row.needsReview) || !supplier || !taxableAmount,
      extractionSource: "AI",
    };
}

function mergeDuplicateDocumentRows(first: ReturnType<typeof normalizeSingleRow>, second: ReturnType<typeof normalizeSingleRow>) {
  const firstAmount = Number(first.taxableAmount || 0);
  const secondAmount = Number(second.taxableAmount || 0);
  const mergedAmount = firstAmount && secondAmount && firstAmount !== secondAmount
    ? String(firstAmount + secondAmount)
    : String(firstAmount || secondAmount || "");
  return {
    ...first,
    documentType: first.documentType || second.documentType,
    supplier: first.supplier || second.supplier,
    documentNumber: first.documentNumber || second.documentNumber,
    documentDate: first.documentDate || second.documentDate,
    taxableAmount: mergedAmount,
    category: first.category || second.category,
    description: [first.description, second.description].filter(Boolean).join(" + ").slice(0, 260),
    confidence: Math.min(first.confidence || 0, second.confidence || 0),
    needsReview: true,
  };
}

function extractionPrompt() {
  return [
    "Sei un analista contabile italiano specializzato in pre-analisi ZES Unica 2026.",
    "Analizza con attenzione tutti i documenti allegati: fatture, preventivi, pro-forme, offerte, conferme d'ordine, ordini, contratti e documenti scansionati.",
    "Devi estrarre righe di investimento da inserire in una checklist Excel.",
    "REGOLA ASSOLUTA: restituisci ESATTAMENTE UNA RIGA PER OGNI FILE allegato.",
    "Non creare mai due righe per lo stesso PDF/immagine, anche se contiene più pagine, più prodotti, più aliquote IVA, più acconti, più lavorazioni o più categorie potenziali.",
    "Se un file contiene più beni/servizi nello stesso documento, aggrega tutto in una sola riga: imponibile totale netto del documento e descrizione sintetica complessiva.",
    "Se un file contiene più categorie, scegli la categoria prevalente per importo o per natura principale dell'investimento.",
    "",
    "OBIETTIVO CAMPI DA ESTRARRE",
    "- sourceFileName: nome file indicato prima dell'allegato.",
    "- documentType: FATTURA, PREVENTIVO oppure PRO-FORMA.",
    "- supplier: fornitore/cedente/prestatore/emittente, non il cliente destinatario.",
    "- documentNumber: numero documento, fattura, preventivo o pro-forma.",
    "- documentDate: data documento in formato YYYY-MM-DD.",
    "- taxableAmount: imponibile/base imponibile/subtotale netto, non totale ivato. Solo numero decimale con punto.",
    "- category: una tra Impianti, Macchinari, Attrezzature, Terreni/Immobili.",
    "- description: descrizione sintetica dell'investimento utile in checklist.",
    "- confidence: valore 0-1.",
    "- needsReview: true se il dato è incerto o manca imponibile/data/fornitore.",
    "",
    "REGOLE DI LETTURA DOCUMENTO",
    "1. Tipo documento:",
    "- FATTURA se trovi parole come fattura, fattura elettronica, cedente/prestatore, cessionario/committente, numero fattura, totale documento.",
    "- PREVENTIVO se trovi preventivo, offerta, proposta economica, conferma preventivo, stima.",
    "- PRO-FORMA se trovi pro-forma, fattura proforma, avviso di parcella pro-forma.",
    "2. Fornitore:",
    "- Per fatture elettroniche usa sempre cedente/prestatore, denominazione o ditta emittente.",
    "- Non usare mai il destinatario/cliente/committente come fornitore.",
    "- Se il nome file contiene un nome fornitore ma il PDF ne mostra uno più preciso, preferisci il PDF.",
    "3. Numero e data:",
    "- Usa numero e data del documento principale, non DDT, ordine, protocollo, CIG/CUP, partita IVA, codice fiscale o IBAN.",
    "- Per fatture elettroniche cerca Numero, Data, Numero fattura, Dati generali documento.",
    "4. Imponibile:",
    "- Priorità assoluta a imponibile, base imponibile, totale imponibile, totale netto, netto merce, subtotale imponibile.",
    "- Non usare totale documento, totale da pagare, netto a pagare, totale ivato, totale fattura se esiste un imponibile separato.",
    "- Se ci sono più aliquote IVA, somma tutte le basi imponibili.",
    "- Se ci sono più righe prodotto/servizio nello stesso documento, somma gli imponibili in una sola taxableAmount.",
    "- Se ci sono sconti, usa il valore dopo lo sconto e prima dell'IVA.",
    "- Se il documento è un preventivo senza IVA esplicita, usa il totale dell'offerta solo se sembra un importo netto o se l'IVA non è indicata.",
    "- Ignora ritenute, bolli, spese incasso, arrotondamenti, acconti già pagati e totale pagamento quando non sono imponibile investimento.",
    "5. Descrizione:",
    "- Crea una descrizione professionale di massimo 18 parole, basata sui beni/servizi effettivi.",
    "- Evita descrizioni generiche come 'macchinari oggetto di investimento' se nel documento ci sono dettagli utili.",
    "",
    "Classificazione:",
    "- Impianti: climatizzazione, ascensori, impianti elettrici/idraulici/fotovoltaici/antincendio/videosorveglianza.",
    "- Macchinari: macchine produttive, linea produzione, presse, tornio, fresa, compressori, carrelli elevatori.",
    "- Attrezzature: arredi, cucina, forni, frigo, lavastoviglie, scaffali, banchi, attrezzature operative.",
    "- Terreni/Immobili: opere edili, ristrutturazioni, pavimenti, infissi, cartongesso, immobili, terreni.",
    "",
    "REGOLE DI QUALITA'",
    "- Se fornitore, numero, data o imponibile sono presenti ma OCR poco chiaro, prova comunque a estrarli e metti confidence più bassa.",
    "- Se l'importo scelto è un totale ivato perché non trovi imponibile, needsReview=true.",
    "- Se trovi più importi candidati, scegli quello più coerente con imponibile/base imponibile e non il più grande per forza.",
    "- Se un PDF ha più pagine, controlla riepiloghi e ultime pagine prima di decidere l'imponibile.",
    "- Prima di rispondere controlla che il numero di rows sia uguale al numero di file allegati.",
    "- Il campo sourceFileName deve corrispondere esattamente a uno dei nomi file ricevuti.",
    "- Non inventare valori. Se un campo non è ricavabile lascia stringa vuota e needsReview=true.",
    "",
    "Restituisci solo JSON conforme allo schema.",
  ].join("\n");
}

const responseSchema = {
  type: "object",
  properties: {
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          sourceFileName: { type: "string" },
          documentType: { type: "string", enum: ["FATTURA", "PREVENTIVO", "PRO-FORMA"] },
          supplier: { type: "string" },
          documentNumber: { type: "string" },
          documentDate: { type: "string" },
          taxableAmount: { type: "string" },
          category: { type: "string", enum: ["Impianti", "Macchinari", "Attrezzature", "Terreni/Immobili"] },
          description: { type: "string" },
          confidence: { type: "number" },
          needsReview: { type: "boolean" },
        },
        required: [
          "sourceFileName",
          "documentType",
          "supplier",
          "documentNumber",
          "documentDate",
          "taxableAmount",
          "category",
          "description",
          "confidence",
          "needsReview",
        ],
      },
    },
  },
  required: ["rows"],
};

async function generatePreAnalysis(parts: GeminiPart[]) {
  let lastErrorText = "";
  let lastStatus = 500;

  for (const model of GEMINI_FALLBACK_MODELS) {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "x-goog-api-key": GEMINI_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.05,
            topP: 0.2,
            topK: 20,
            responseMimeType: "application/json",
            responseJsonSchema: responseSchema,
          },
        }),
      });

      if (response.ok) {
        return await response.json();
      }

      lastStatus = response.status;
      lastErrorText = await response.text();

      if (isUnsupportedGeminiModel(response.status, lastErrorText)) {
        break;
      }

      if (!isTemporaryGeminiError(response.status, lastErrorText)) {
        throw new Error(userFriendlyGeminiError(lastErrorText, `Gemini: ${lastErrorText}`));
      }

      if (response.status === 503) break;
      await sleep(900 * (attempt + 1) + Math.floor(Math.random() * 500));
    }
  }

  throw new Error(userFriendlyGeminiError(lastErrorText, `AI temporaneamente non disponibile (${lastStatus})`));
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  if (!GEMINI_API_KEY) {
    return jsonResponse({ error: "GEMINI_API_KEY non configurata" }, 500);
  }

  try {
    const body = await req.json();
    const documents = (body.documents || []) as IncomingDocument[];

    if (!Array.isArray(documents) || documents.length === 0) {
      return jsonResponse({ error: "Nessun documento ricevuto" }, 400);
    }

    if (documents.length > 12) {
      return jsonResponse({ error: "Carica massimo 12 documenti per analisi" }, 400);
    }

    const parts: GeminiPart[] = [{ text: extractionPrompt() }];

    for (const document of documents) {
      const base64 = cleanBase64(document.base64);
      if (!document.fileName || !base64) {
        return jsonResponse({ error: `File non valido o vuoto: ${document.fileName || "senza nome"}` }, 400);
      }

      parts.push({ text: `\n--- FILE: ${document.fileName} ---` });
      parts.push({
        inlineData: {
          mimeType: document.mimeType || "application/pdf",
          data: base64,
        },
      });
    }

    const result = await generatePreAnalysis(parts);
    const outputText = result.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || "")
      .join("")
      .trim();

    if (!outputText) {
      return jsonResponse({ error: "Risposta Gemini vuota" }, 500);
    }

    return jsonResponse({ rows: normalizeRows(JSON.parse(outputText)) });
  } catch (error) {
    return jsonResponse({ error: String(error?.message || error) }, 500);
  }
});

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = Deno.env.get("GEMINI_CLIENT_REGISTRY_MODEL") || "gemini-2.5-flash";

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

function cleanString(value: unknown, max = 180) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function onlyDigits(value: unknown, max = 32) {
  return String(value || "").replace(/\D/g, "").slice(0, max);
}

function normalizeProvince(value: unknown) {
  return cleanString(value, 8).toUpperCase();
}

function normalizeAddress(value: unknown) {
  const address = (value || {}) as Record<string, unknown>;
  return {
    street: cleanString(address.street, 220),
    cap: onlyDigits(address.cap, 5),
    city: cleanString(address.city, 120),
    province: normalizeProvince(address.province),
    state: cleanString(address.state || "Italia", 80),
  };
}

function normalizeRegistryData(value: unknown) {
  const data = (value || {}) as Record<string, unknown>;
  const owner = (data.owner || {}) as Record<string, unknown>;
  const contacts = (data.contacts || {}) as Record<string, unknown>;
  const legalAddress = normalizeAddress(data.legalAddress);
  const operatingLocations = Array.isArray(data.operatingLocations)
    ? data.operatingLocations.map(normalizeAddress).filter((address) =>
      Object.values(address).some(Boolean)
    )
    : [];

  return {
    businessName: cleanString(data.businessName, 220),
    atecoCode: cleanString(data.atecoCode, 32),
    vatNumber: onlyDigits(data.vatNumber, 16),
    uniqueCode: cleanString(data.uniqueCode, 16).toUpperCase(),
    businessFiscalCode: cleanString(data.businessFiscalCode, 24).toUpperCase(),
    sector: cleanString(data.sector, 220),
    contacts: {
      contactEmail: cleanString(contacts.contactEmail, 160).toLowerCase(),
      contactMobile: cleanString(contacts.contactMobile, 60),
      contactPec: cleanString(contacts.contactPec, 160).toLowerCase(),
      contactPhone: cleanString(contacts.contactPhone, 60),
      website: cleanString(contacts.website, 180),
    },
    owner: {
      firstName: cleanString(owner.firstName, 100),
      lastName: cleanString(owner.lastName, 100),
      fiscalCode: cleanString(owner.fiscalCode, 24).toUpperCase(),
      email: cleanString(owner.email, 160).toLowerCase(),
      phone: cleanString(owner.phone, 60),
      role: cleanString(owner.role, 160),
    },
    legalAddress,
    operatingLocations,
    notes: cleanString(data.notes, 900),
    confidence: Math.max(0, Math.min(1, Number(data.confidence || 0))),
    missingFields: Array.isArray(data.missingFields)
      ? data.missingFields.map((field) => cleanString(field, 80)).filter(Boolean)
      : [],
  };
}

function extractionPrompt() {
  return [
    "Sei un analista italiano specializzato in lettura di visure camerali e documenti Registro Imprese.",
    "Analizza la visura camerale allegata e restituisci i dati utili per compilare una scheda cliente CRM.",
    "Devi estrarre solo dati presenti nel documento o chiaramente deducibili dalla visura. Non inventare nulla.",
    "",
    "CAMPI DA ESTRARRE",
    "- businessName: denominazione/ragione sociale esatta dell'impresa.",
    "- atecoCode: codice ATECO prevalente/principale, nel formato più completo visibile.",
    "- vatNumber: partita IVA.",
    "- uniqueCode: codice destinatario/codice univoco solo se presente nella visura.",
    "- businessFiscalCode: codice fiscale impresa.",
    "- sector: descrizione sintetica dell'attività prevalente o oggetto sociale operativo.",
    "- contacts.contactEmail: email ordinaria solo se presente.",
    "- contacts.contactMobile: cellulare solo se presente.",
    "- contacts.contactPec: PEC dell'impresa.",
    "- contacts.contactPhone: telefono fisso solo se presente.",
    "- contacts.website: sito web solo se presente.",
    "- owner: rappresentante legale, titolare, amministratore unico o soggetto con carica principale.",
    "- owner.firstName, owner.lastName, owner.fiscalCode, owner.email, owner.phone, owner.role.",
    "- legalAddress: sede legale con via, CAP, città, provincia, stato.",
    "- operatingLocations: sedi operative/unità locali/sedi secondarie, se presenti, con stessi campi della sede legale.",
    "- notes: massimo 2 frasi utili, per esempio forma giuridica, REA, stato attività, capitale sociale, carica del rappresentante.",
    "- confidence: valore 0-1.",
    "- missingFields: elenco campi importanti non trovati.",
    "",
    "REGOLE IMPORTANTI",
    "- Non confondere sede legale con unità locale/sede operativa.",
    "- Se una sezione riporta molte persone, scegli come titolare/rappresentante il soggetto con carica più rilevante: legale rappresentante, amministratore unico, presidente CDA, titolare.",
    "- Se non trovi nome/cognome separati, prova a separarli dal nominativo italiano mantenendo cognomi composti.",
    "- Per Codice ATECO preferisci attività prevalente/primaria rispetto a secondarie.",
    "- Per Settore scrivi una descrizione leggibile, non solo il codice.",
    "- Per Stato usa Italia se il documento indica una sede italiana.",
    "- Se la visura non contiene telefono/email ordinaria/sito, lascia vuoto.",
    "- Restituisci solo JSON conforme allo schema.",
  ].join("\n");
}

const responseSchema = {
  type: "object",
  properties: {
    businessName: { type: "string" },
    atecoCode: { type: "string" },
    vatNumber: { type: "string" },
    uniqueCode: { type: "string" },
    businessFiscalCode: { type: "string" },
    sector: { type: "string" },
    contacts: {
      type: "object",
      properties: {
        contactEmail: { type: "string" },
        contactMobile: { type: "string" },
        contactPec: { type: "string" },
        contactPhone: { type: "string" },
        website: { type: "string" },
      },
    },
    owner: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        fiscalCode: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        role: { type: "string" },
      },
    },
    legalAddress: {
      type: "object",
      properties: {
        street: { type: "string" },
        cap: { type: "string" },
        city: { type: "string" },
        province: { type: "string" },
        state: { type: "string" },
      },
    },
    operatingLocations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          street: { type: "string" },
          cap: { type: "string" },
          city: { type: "string" },
          province: { type: "string" },
          state: { type: "string" },
        },
      },
    },
    notes: { type: "string" },
    confidence: { type: "number" },
    missingFields: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: [
    "businessName",
    "atecoCode",
    "vatNumber",
    "uniqueCode",
    "businessFiscalCode",
    "sector",
    "contacts",
    "owner",
    "legalAddress",
    "operatingLocations",
    "notes",
    "confidence",
    "missingFields",
  ],
};

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
    const document = (body.document || {}) as IncomingDocument;
    const base64 = cleanBase64(document.base64);

    if (!document.fileName || !base64) {
      return jsonResponse({ error: "Documento visura non valido o vuoto" }, 400);
    }

    const parts: GeminiPart[] = [
      { text: extractionPrompt() },
      { text: `\n--- VISURA CAMERALE: ${document.fileName} ---` },
      {
        inlineData: {
          mimeType: document.mimeType || "application/pdf",
          data: base64,
        },
      },
    ];

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "x-goog-api-key": GEMINI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.03,
          topP: 0.2,
          topK: 20,
          responseMimeType: "application/json",
          responseJsonSchema: responseSchema,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return jsonResponse({ error: `Gemini: ${errorText}` }, 500);
    }

    const result = await response.json();
    const outputText = result.candidates?.[0]?.content?.parts
      ?.map((part: { text?: string }) => part.text || "")
      .join("")
      .trim();

    if (!outputText) {
      return jsonResponse({ error: "Risposta Gemini vuota" }, 500);
    }

    return jsonResponse({ client: normalizeRegistryData(JSON.parse(outputText)) });
  } catch (error) {
    return jsonResponse({ error: String(error?.message || error) }, 500);
  }
});

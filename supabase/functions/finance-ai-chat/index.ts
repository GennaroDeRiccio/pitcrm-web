import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") || "";
const GEMINI_MODEL = Deno.env.get("GEMINI_FINANCE_CHAT_MODEL") || "gemini-2.0-flash";
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

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
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
    return "Gemini è temporaneamente sovraccarico. Riprova tra qualche minuto.";
  }
  if (parsed.status === "RESOURCE_EXHAUSTED" || parsed.code === 429) {
    return "Limite temporaneo Gemini raggiunto. Attendi qualche minuto e riprova.";
  }
  return fallback;
}

function cleanText(value: unknown, max = 6000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanBase64(value: string) {
  return String(value || "").replace(/^data:[^;]+;base64,/, "").trim();
}

function systemPrompt() {
  return [
    "Sei AI Finance, assistente professionale per finanza, finanza agevolata, pratiche ZES Unica, incentivi, credito d'imposta, documentazione e analisi preliminari.",
    "Rispondi in italiano, con tono operativo e da consulente senior.",
    "Rispondi in modo breve ma dettagliato: massimo 10-14 righe salvo richiesta esplicita di approfondimento.",
    "Vai subito al punto, evita premesse, formule di cortesia e spiegazioni generiche.",
    "Preferisci bullet sintetici con controlli, rischi e prossimi passi concreti.",
    "Devi aiutare l'utente a ragionare, preparare checklist, impostare pratiche, evidenziare rischi, suggerire documenti e formulare prossimi passi.",
    "Non devi inventare norme, scadenze, percentuali o requisiti. Se non sei certo, dichiaralo e chiedi di verificare su fonte ufficiale o di caricare la documentazione.",
    "Per temi fiscali, legali, agevolativi o finanziari ad alto impatto, fornisci supporto operativo ma ricorda che la validazione finale spetta a un professionista abilitato.",
    "Quando utile, struttura la risposta con: Sintesi, Requisiti/controlli, Documenti necessari, Rischi, Prossimi passi.",
    "Non dire di poter compilare o presentare pratiche se non hai i dati necessari. Chiedi i dati mancanti in modo mirato.",
  ].join("\n");
}

function buildContents(message: string, history: ChatMessage[], knowledge: string, documents: IncomingDocument[]) {
  const context = history.slice(-8).map((item) => {
    const role = item.role === "assistant" ? "Assistente" : "Utente";
    return `${role}: ${cleanText(item.content, 1500)}`;
  }).join("\n\n");

  const parts: GeminiPart[] = [{
    text: [
      systemPrompt(),
      knowledge ? `\nCONTESTO INTERNO PIT CRM\n${knowledge}\nUsa questo contesto solo se pertinente. Se il contesto è insufficiente o non ufficiale, dichiaralo.` : "",
      context ? `\nCONVERSAZIONE RECENTE\n${context}` : "",
      `\nDOMANDA UTENTE\n${message}`,
      documents.length ? "\nAnalizza anche gli allegati forniti. Se un allegato non è leggibile, dichiaralo." : "",
    ].join("\n"),
  }];

  for (const document of documents) {
    const base64 = cleanBase64(document.base64);
    if (!base64) continue;
    parts.push({ text: `\n--- ALLEGATO: ${document.fileName} ---` });
    parts.push({
      inlineData: {
        mimeType: document.mimeType || "application/pdf",
        data: base64,
      },
    });
  }

  return [{
    role: "user",
    parts,
  }];
}

async function generateFinanceAnswer(message: string, history: ChatMessage[], knowledge: string, documents: IncomingDocument[]) {
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
          contents: buildContents(message, history, knowledge, documents),
          generationConfig: {
            temperature: 0.25,
            topP: 0.75,
            topK: 30,
            maxOutputTokens: 700,
          },
        }),
      });

      if (response.ok) {
        const result = await response.json();
        const answer = result.candidates?.[0]?.content?.parts
          ?.map((part: { text?: string }) => part.text || "")
          .join("")
          .trim();
        if (answer) return { answer, model };
        throw new Error("Risposta Gemini vuota");
      }

      lastStatus = response.status;
      lastErrorText = await response.text();

      if (isUnsupportedGeminiModel(response.status, lastErrorText)) break;
      if (!isTemporaryGeminiError(response.status, lastErrorText)) {
        throw new Error(userFriendlyGeminiError(lastErrorText, `Gemini: ${lastErrorText}`));
      }
      if (response.status === 503) break;
      await sleep(800 * (attempt + 1) + Math.floor(Math.random() * 400));
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
    const message = cleanText(body.message, 4000);
    const history = Array.isArray(body.history) ? body.history as ChatMessage[] : [];
    const knowledge = cleanText(body.knowledge, 6000);
    const documents = Array.isArray(body.documents) ? body.documents as IncomingDocument[] : [];

    if (!message && !documents.length) {
      return jsonResponse({ error: "Messaggio vuoto" }, 400);
    }

    const result = await generateFinanceAnswer(message || "Analizza gli allegati e sintetizza gli elementi rilevanti.", history, knowledge, documents.slice(0, 4));
    return jsonResponse(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: message }, 500);
  }
});

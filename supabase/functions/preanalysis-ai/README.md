# preanalysis-ai

Edge Function Supabase usata dalla pagina desktop `Pre-analisi`.

## Variabili richieste

- `GEMINI_API_KEY`: chiave Google Gemini API creata da Google AI Studio.
- `GEMINI_PREANALYSIS_MODEL`: opzionale, default `gemini-2.5-flash`.

## Deploy

```bash
supabase secrets set GEMINI_API_KEY="..."
supabase functions deploy preanalysis-ai --no-verify-jwt
```

La funzione non salva file: riceve temporaneamente PDF/immagini in base64, li invia a Gemini con output JSON strutturato, e restituisce righe già normalizzate per il CRM.

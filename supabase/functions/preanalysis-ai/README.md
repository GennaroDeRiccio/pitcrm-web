# preanalysis-ai

Edge Function Supabase usata dalla pagina desktop `Pre-analisi`.

## Variabili richieste

- `GEMINI_API_KEY`: chiave Google Gemini API creata da Google AI Studio.
- `GEMINI_PREANALYSIS_MODEL`: opzionale, default `gemini-2.0-flash`.
- `GEMINI_CLIENT_REGISTRY_MODEL`: opzionale per `client-registry-ai`, default `gemini-2.0-flash`.

## Deploy

```bash
supabase secrets set GEMINI_API_KEY="..."
supabase functions deploy preanalysis-ai --no-verify-jwt
supabase functions deploy client-registry-ai --no-verify-jwt
```

Le funzioni non salvano file: ricevono temporaneamente PDF/immagini in base64, li inviano a Gemini con output JSON strutturato, e restituiscono dati già normalizzati per il CRM.

# iperammortamento-ai

Edge Function Gemini per distinguere fatture e preventivi, estrarre imponibili netti e sintetizzare i beni per la simulazione Iperammortamento.

## Variabili

- `GEMINI_API_KEY`: chiave API Gemini gia configurata per le altre funzioni AI.
- `GEMINI_IPERAMMORTAMENTO_MODEL`: opzionale, default `gemini-2.0-flash`.

## Deploy

```bash
supabase functions deploy iperammortamento-ai --no-verify-jwt
```

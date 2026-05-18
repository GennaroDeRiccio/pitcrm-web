# Comunicazione integrativa

## Obiettivo

Aggiungere alla pagina `Pratiche` una sezione separata chiamata `Comunicazione integrativa` che consente di caricare:

- visura camerale in PDF o immagine;
- check-list / pre-analisi in formato Excel.

Il sistema deve estrarre i dati, mostrarli all'utente per revisione e generare il PDF sul modello ZES 2025 `modello_comunicazione_integrativa_2025.pdf`.

Il PDF finale viene esportato con 5 pagine: informativa, frontespizio, dichiarazione sostitutiva, Quadro A e Quadro B. Le pagine successive del modello 2025, incluso il `QUADRO D - ALTRE AGEVOLAZIONI`, non vengono incluse o compilate.

## Metodo

Il modello PDF non contiene campi AcroForm compilabili. La generazione deve quindi avvenire con overlay a coordinate:

1. usare il PDF originale come sfondo;
2. creare un layer con testi, importi e spunte alle coordinate definite;
3. unire layer e modello;
4. esportare il PDF finale.

La compilazione del PDF deve essere deterministica. L'AI va usata solo per:

- lettura della visura camerale, tramite funzione esistente `client-registry-ai`;
- eventuale generazione della descrizione progetto tra 800 e 1000 caratteri, partendo da attività esercitata, sede produttiva, beni e finalità dell'investimento, senza citare documenti sorgente o importi;
- eventuale classificazione assistita se i dati Excel non sono sufficientemente espliciti.

## Pagine da compilare

### Pagina 2 - Frontespizio

Campi compilati ora:

- codice fiscale impresa beneficiaria;
- dimensione impresa: grande, media, piccola, micro;
- data dell'impegno, scelta dall'utente in anteprima.

Campi ora effettivi sul foglio 1:

- codice fiscale firmatario, distinto dal codice fiscale dell'impresa beneficiaria;
- codice carica firmatario;
- referente da contattare: cognome, nome, telefono, cellulare e indirizzo di posta elettronica;
- codice fiscale del soggetto incaricato;
- data impegno.

Le firme restano da gestire in seguito come immagini firma da inserire nelle rispettive caselle.

### Pagina 3 - Dichiarazione sostitutiva

Campi:

- codice fiscale impresa;
- area firma lasciata vuota.

Le dichiarazioni non vanno desunte automaticamente senza conferma. L'interfaccia deve chiedere all'utente di confermare il possesso dei requisiti prima di generare il PDF.

### Pagina 4 - Quadro A

Campi automatici o calcolabili:

- codice fiscale;
- modello numero;
- investimento complessivo;
- credito d'imposta complessivo;
- investimento realizzato e fatturato;
- investimento realizzato e non fatturabile;
- investimento non realizzato o non fatturato;
- credito d'imposta diviso per stato investimento;
- data inizio investimento;
- data fine investimento;
- numero strutture produttive;
- descrizione progetto.

La descrizione progetto deve avere tra 800 e 1000 caratteri. Se generata automaticamente, deve spiegare in modo generale l'attività esercitata, il motivo degli investimenti, il collegamento con la struttura produttiva e la coerenza con i criteri del modello di comunicazione integrativa, senza nominare prodotti specifici, importi, check-list, visura o ZES.

Origine dati Quadro A:

- A1 investimento complessivo: valore Excel associato alla voce `Agevolabile`; fallback tecnico su `J88` se l'etichetta non viene trovata;
- A1 credito d'imposta complessivo: valore Excel associato alla voce `MAX. Credito d'imposta ottenibile`; fallback tecnico su `N88` se l'etichetta non viene trovata;
- stato del credito: scelta manuale in anteprima tra investimenti realizzati/fatturati, realizzati/non fatturabili, non realizzati/non fatturati;
- A2 investimento: stesso valore di A1 investimento complessivo;
- A2 credito d'imposta: stesso valore di A1 credito d'imposta complessivo;
- A2 stato credito: stessa scelta usata per A1.
- A2 date inizio/fine investimento: valori scelti in anteprima, scritti con dimensione ridotta per restare centrati nei campi giorno/mese/anno.
- A3 crocette ambito attivita: ogni opzione scrive una `X` testuale nella casella corrispondente.
- Sezione IV descrizione/riassunto: testo generato collegando investimento A1/A2, credito d'imposta A1/A2, stato investimento scelto, date, tipologia progetto, ambito attivita e numero strutture.

Campi manuali o da confermare:

- tipologia progetto: nuovo stabilimento, ampliamento stabilimento, nuovi prodotti/servizi, cambiamento processo produttivo;
- ambito attività A3;
- date investimento, se non presenti in check-list;
- credito d'imposta, se la check-list contiene solo investimenti e non percentuali/intensità.

### Pagina 5 - Quadro B

Campi automatici o calcolabili:

- codice fiscale;
- modello numero;
- numero modulo quadro A;
- regione;
- codice regione;
- comune;
- provincia;
- codice comune;
- tipologia indirizzo;
- indirizzo;
- numero civico;
- codice attività;
- investimento realizzato e fatturato;
- investimento realizzato e non fatturabile;
- investimento non realizzato o non fatturato;
- impianti;
- macchinari;
- attrezzature;
- immobili;
- totale investimenti;
- intensità;
- credito d'imposta;
- credito da ridurre;
- importi B30-B35.

Campi manuali o da confermare:

- struttura non operativa;
- casi particolari;
- regolamento STEP;
- altri aiuti/de minimis;
- altre agevolazioni;
- intensità applicabile, se non derivabile con certezza.

## Origine dati

### Visura camerale

Dati ricavabili:

- ragione sociale;
- codice fiscale / partita IVA;
- ATECO;
- sede legale;
- unità locali / sedi operative;
- rappresentante legale;
- PEC e contatti, se presenti.

Fonte tecnica: Edge Function `client-registry-ai`.

### Check-list Excel

Dati ricavabili:

- righe investimento;
- categorie: impianti, macchinari, attrezzature, immobili;
- fornitore;
- descrizione bene;
- imponibile / investimento;
- eventuali date/documenti;
- totali per categoria;
- totale investimento.

Fonte tecnica: parser Excel deterministico.

## Regole di accuratezza

- Non compilare campi fiscali o dichiarazioni non confermati dall'utente.
- Non inventare importi, percentuali o date.
- Gli importi devono essere formattati come nel modello 2025: parte intera in overlay e `,00` già presente nel PDF.
- La descrizione progetto deve essere compresa tra 800 e 1000 caratteri, in modo da entrare nel riquadro del modello.
- La descrizione progetto non deve citare check-list, visura, ZES, prodotti specifici o importi investiti.
- Investimento e credito d'imposta vanno arrotondati per eccesso prima della compilazione.
- I campi testuali vanno precompilati in maiuscolo.
- I campi firma devono restare vuoti.
- Le caselle vanno marcate con `X`, non con simbolo di spunta.
- Il PDF finale va verificato visivamente su tutte le pagine compilate.

## Mapping implementato

### Frontespizio - pagina 2

- codice fiscale impresa a caratteri singoli;
- dimensione impresa con casella selezionata, letta dal riquadro `DIMENSIONE` della check-list;
- data impegno;
- codice carica allineato al campo dedicato della sezione rappresentante firmatario;
- codice fiscale firmatario precompilato con il codice fiscale del cliente/impresa beneficiaria;
- cognome, nome, email principale, telefono e cellulare del referente compilati dai dati del legale rappresentante e dai contatti principali della visura/anagrafica;
- codice fiscale soggetto incaricato predefinito su Professioni in Team: `10080141210`;
- campi firmatario, referente e soggetto incaricato effettivi e compilati nel PDF;
- firme non compilate fino all'implementazione del caricamento immagine firma;
- firme non compilate.

### Dichiarazione - pagina 3

- codice fiscale impresa a caratteri singoli;
- firme non compilate.

### Quadro A - pagina 4

- codice fiscale impresa a caratteri singoli;
- modello numero;
- A1: investimento complessivo, credito d'imposta, investimenti realizzati/fatturati, non fatturabili, non realizzati;
- tipologia progetto;
- numero strutture produttive;
- date inizio/fine investimento;
- A2: investimento, credito e dettaglio stato investimento;
- A3: ambito attività;
- descrizione progetto con righe controllate.

### Quadro B - pagina 5

- codice fiscale impresa a caratteri singoli;
- modello numero;
- modulo quadro A;
- regione, codice regione, comune, provincia, codice comune;
- select delle sedi operative, con default sulla sede operativa indicata nella check-list;
- codice regione derivato dalla tabella regioni fornita dall'utente;
- codice comune derivato dalla tabella codici catastali comuni fornita dall'utente;
- struttura non operativa;
- tipologia indirizzo, indirizzo, numero civico;
- codice attività, casi particolari, regolamento STEP;
- B10 investimento e dettaglio stato;
- B11-B14 categorie impianti, macchinari, attrezzature, immobili: lettura dei totali in basso nella riga `Investimenti ammissibili`, sotto le rispettive intestazioni di colonna;
- B19 totale investimento e credito d'imposta: stessi valori generali già usati nel quadro A, cioè `Agevolabile` e `MAX. Credito d'imposta ottenibile`;
- B35 ripartizione beni strumentali non ricadenti negli altri ambiti, quando non classificabile con certezza.

## Step implementativi

1. Creare mappa coordinate pagine 2-5.
2. Creare modello dati `integrativaDraft`.
3. Aggiungere sezione `Comunicazione integrativa` nella pagina `Pratiche`.
4. Implementare upload visura e check-list Excel.
5. Estrarre dati e mostrare anteprima modificabile.
6. Generare descrizione progetto tra 800 e 1000 caratteri.
7. Generare PDF overlay.
8. Verificare anteprima ed export finale.

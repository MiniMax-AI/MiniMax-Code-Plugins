# Public API catalog

| Source | Best for | Key caution | Documentation |
|---|---|---|---|
| NCBI E-utilities | identifier and literature/sequence index search | respect rate limits; record database and query | <https://www.ncbi.nlm.nih.gov/books/NBK25501/> |
| UniProt REST | protein records and annotations | distinguish reviewed and unreviewed records | <https://rest.uniprot.org/> |
| InterPro API | protein families, domains, and sites | domain presence constrains function but rarely identifies mechanism | <https://www.ebi.ac.uk/interpro/api/> |
| Ensembl REST | public genome annotation lookup | record species and stable ID/version | <https://rest.ensembl.org/> |
| AlphaFold DB API | predicted protein structures | inspect pLDDT/PAE, coverage, disorder, and oligomeric assumptions | <https://alphafold.ebi.ac.uk/api-docs> |
| RCSB PDB Data API | deposited structure metadata | inspect experimental method, resolution, construct, and assembly | <https://data.rcsb.org/> |
| Europe PMC REST | literature discovery | a search hit is not verified claim support | <https://europepmc.org/RestfulWebService> |
| STRING API | functional association networks | combined scores mix evidence channels | <https://string-db.org/help/api/> |
| JASPAR REST | transcription-factor binding profiles | sequence matches require experimental validation | <https://jaspar.elixir.no/api/v1/docs/> |
| SGN public BrAPI metadata | general Solanaceae-resource metadata | public generic metadata only; dedicated pepper operations are excluded | <https://solgenomics.net/brapi/v2/commoncropnames> |

The API server is an access layer, not a redistribution of these databases. Check current provider terms before high-volume use.

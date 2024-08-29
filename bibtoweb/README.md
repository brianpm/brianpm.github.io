
To create publications.html, I follow this workflow:

- from my master BibTex database, get a .bib file of all my publications
- save that file here to keep for provenance
- run the python script bib_converter.py:
  + `python bib_converter.py input.bib output.html`
- Then just move publications.html to parent directory.

I am just manually injecting all the html before and after the list of publications.

Dependencies
- python
- pylatexenc
- bibtexparser -- NOTE v2 required


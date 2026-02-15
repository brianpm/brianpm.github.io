#!/usr/bin/env python
"""
Extract publications with B. Medeiros as author from master BibTeX file.

This script reads the master refs.bib file from Dropbox and creates a new
BibTeX file containing only publications where Brian Medeiros is an author.
The output file is named with today's date following the convention:
mybib_YYYY_MM_DD.bib

Usage:
    python extract_my_pubs.py
"""

import bibtexparser
from datetime import date
import re
import os


def matches_medeiros(author_string):
    """
    Check if the author string contains any variation of Brian Medeiros.

    Matches variations like:
    - "Medeiros, Brian"
    - "Brian Medeiros"
    - "Medeiros, B."
    - "B. Medeiros"

    Args:
        author_string: String containing author names from BibTeX entry

    Returns:
        bool: True if any form of B. Medeiros is found in the author list
    """
    # Normalize whitespace
    author_string = ' '.join(author_string.split())

    # Split on " and " to get individual authors
    authors = author_string.split(' and ')

    # Patterns to match various forms of the name
    patterns = [
        r'Medeiros,\s*Brian',
        r'Brian\s+Medeiros',
        r'Medeiros,\s*B\.?',
        r'B\.?\s+Medeiros'
    ]

    for author in authors:
        author = author.strip()
        for pattern in patterns:
            if re.search(pattern, author, re.IGNORECASE):
                return True
    return False


def extract_medeiros_publications(input_bib, output_bib):
    """
    Extract all publications with B. Medeiros as an author from the master bib file.

    Args:
        input_bib: Path to master BibTeX file
        output_bib: Path to output BibTeX file

    Returns:
        int: Number of publications extracted
    """
    # Read the master bib file
    library = bibtexparser.parse_file(input_bib)

    # Filter entries with Medeiros as author
    medeiros_entries = []
    for entry in library.entries:
        author_field = entry.get('author')
        if author_field and matches_medeiros(author_field.value):
            medeiros_entries.append(entry)

    # Create a new library with only Medeiros publications
    medeiros_library = bibtexparser.Library()

    # Add @string definitions (journal abbreviations, etc.)
    for string in library.strings:
        medeiros_library.add(string)

    # Add preambles
    for preamble in library.preambles:
        medeiros_library.add(preamble)

    # Add the filtered entries
    for entry in medeiros_entries:
        medeiros_library.add(entry)

    # Write to output file
    bibtexparser.write_file(output_bib, medeiros_library)

    return len(medeiros_entries)


def main():
    """Main function to extract publications and save to dated file."""
    # Source and destination paths
    master_bib = "/Users/brianpm/Dropbox/refs.bib"
    today = date.today()
    output_filename = f"mybib_{today.year}_{today.month:02d}_{today.day:02d}.bib"

    # Get the directory where this script is located
    script_dir = os.path.dirname(os.path.abspath(__file__))
    output_path = os.path.join(script_dir, output_filename)

    # Check if file already exists
    file_existed = os.path.exists(output_path)

    print(f"Reading master bibliography from: {master_bib}")

    # Extract publications
    count = extract_medeiros_publications(master_bib, output_path)

    print(f"\nExtracted {count} publications with B. Medeiros as author")
    print(f"Output written to: {output_path}")

    if file_existed:
        print(f"\nNote: {output_filename} already existed and was overwritten")


if __name__ == "__main__":
    main()

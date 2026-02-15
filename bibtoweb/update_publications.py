#!/usr/bin/env python
"""
Complete workflow to update publications.html from master BibTeX file.

This script:
1. Extracts publications with B. Medeiros as author from master refs.bib
2. Converts the BibTeX to HTML format
3. Archives the existing publications.html
4. Deploys the new publications.html

Usage:
    python update_publications.py
"""

import os
import shutil
from datetime import datetime
from pathlib import Path

# Import functions from existing scripts
from extract_my_pubs import extract_medeiros_publications
from bib_converter import main as convert_to_html


def archive_existing_publications(publications_path, archive_dir):
    """
    Create a timestamped archive of the existing publications.html file.

    Args:
        publications_path: Path to current publications.html
        archive_dir: Directory to store archives

    Returns:
        str: Path to archived file, or None if no file existed
    """
    if not os.path.exists(publications_path):
        print(f"No existing publications file found at {publications_path}")
        return None

    # Create archive directory if it doesn't exist
    os.makedirs(archive_dir, exist_ok=True)

    # Create timestamped archive name
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    archive_name = f"publications_{timestamp}.html"
    archive_path = os.path.join(archive_dir, archive_name)

    # Copy the file
    shutil.copy2(publications_path, archive_path)
    print(f"Archived existing publications.html to: {archive_path}")
    return archive_path


def main():
    """Run the complete publications update workflow."""
    print("=" * 70)
    print("PUBLICATIONS UPDATE WORKFLOW")
    print("=" * 70)

    # Define paths
    script_dir = Path(__file__).parent.absolute()
    master_bib = Path("/Users/brianpm/Dropbox/refs.bib")
    site_root = script_dir.parent
    publications_html = site_root / "publications.html"
    archive_dir = script_dir / "archive"

    # Generate dated filename for intermediate BibTeX file
    today = datetime.now().date()
    bib_filename = f"mybib_{today.year}_{today.month:02d}_{today.day:02d}.bib"
    output_bib = script_dir / bib_filename
    temp_html = script_dir / "publications_new.html"

    print(f"\nStep 1: Extracting publications from master bibliography")
    print(f"  Master: {master_bib}")
    print(f"  Output: {output_bib}")

    # Check if master bib file exists
    if not master_bib.exists():
        print(f"\nERROR: Master bibliography not found at {master_bib}")
        print("Please ensure your Dropbox is mounted and refs.bib exists.")
        return 1

    # Extract publications
    file_existed = output_bib.exists()
    count = extract_medeiros_publications(str(master_bib), str(output_bib))
    print(f"  ✓ Extracted {count} publications with B. Medeiros as author")
    if file_existed:
        print(f"  Note: {bib_filename} was overwritten")

    print(f"\nStep 2: Converting BibTeX to HTML")
    print(f"  Input:  {output_bib}")
    print(f"  Output: {temp_html}")

    # Convert to HTML
    convert_to_html(str(output_bib), str(temp_html))
    print(f"  ✓ Generated HTML with {count} publications")

    print(f"\nStep 3: Archiving existing publications.html")
    archive_path = archive_existing_publications(str(publications_html), str(archive_dir))
    if archive_path:
        print(f"  ✓ Backup created")
    else:
        print(f"  ℹ No existing file to archive")

    print(f"\nStep 4: Deploying new publications.html")
    print(f"  Source: {temp_html}")
    print(f"  Target: {publications_html}")

    # Deploy the new file
    shutil.copy2(str(temp_html), str(publications_html))
    print(f"  ✓ Deployed successfully")

    # Clean up temporary HTML
    os.remove(str(temp_html))
    print(f"  ✓ Cleaned up temporary files")

    print("\n" + "=" * 70)
    print("WORKFLOW COMPLETE")
    print("=" * 70)
    print(f"\nPublications page updated with {count} publications")
    print(f"BibTeX archive: {output_bib}")
    if archive_path:
        print(f"HTML backup:    {archive_path}")
    print(f"\nNext steps:")
    print(f"  - Review {publications_html}")
    print(f"  - Commit and push changes to deploy to GitHub Pages")

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())

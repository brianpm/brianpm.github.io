import requests
from bs4 import BeautifulSoup

BASE_URL = "https://gml.noaa.gov/data/data.php?parameter_name=Carbon%252BDioxide&frequency=Monthly%2BAverages"
DATA_URL_TEMPLATE = "https://gml.noaa.gov/aftp/data/trace_gases/co2/flask/surface/txt/co2_{site}_surface-flask_1_ccgg_month.txt"

def get_site_list():
    sites = []
    page = 1
    while True:
        url = BASE_URL + (f"&pageID={page}" if page > 1 else "")
        r = requests.get(url)
        soup = BeautifulSoup(r.text, "html.parser")
        table = soup.find("table")
        if not table:
            break
        for row in table.find_all("tr"):
            cols = row.find_all("td")
            if len(cols) < 2:
                continue
            desc = cols[1].get_text()
            if "Monthly averages" in desc and "surface air samples" in desc:
                # Example: "Ascension Island, United Kingdom (ASC) Monthly averages of CO2 measurements from surface air samples collected in glass flasks at Ascension Island, United Kingdom."
                if "(" in desc and ")" in desc:
                    name = desc.split("Monthly averages")[0].strip()
                    code = name.split("(")[-1].replace(")", "").strip().lower()
                    label = name.strip()
                    sites.append((code, label))
        # Check for next page
        if f"pageID={page+1}" in r.text:
            page += 1
        else:
            break
    return sites

def generate_dropdown_and_mapping(sites):
    dropdown = []
    mapping = []
    for code, label in sites:
        dropdown.append(f'      <option value="{code}">{label}</option>')
        mapping.append(f'      {code}: "{DATA_URL_TEMPLATE.format(site=code)}"')
    return "\n".join(dropdown), ",\n".join(mapping)

if __name__ == "__main__":
    sites = get_site_list()
    dropdown, mapping = generate_dropdown_and_mapping(sites)
    print("<!-- Dropdown options -->")
    print(dropdown)
    print("\n// SITE_URLS mapping")
    print("const SITE_URLS = {\n" + mapping + "\n};")
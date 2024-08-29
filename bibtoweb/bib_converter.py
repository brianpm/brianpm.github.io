import argparse
from pylatexenc.latex2text import LatexNodes2Text
import bibtexparser

def produce_author_field(ainput):
    result = []
    a = ainput.split(" and ") # NOTE: has to have spaces otherwise will split names that include `and` (e.g. Rolando)
    for aelem in a:
        # if comma, assumes [LAST, FIRST [initials]]
        if "," in aelem:
            namelist = aelem.split(',')
            namelist = [n.strip() for n in namelist]
            namelist.reverse()
            result.append(" ".join(namelist))
        else:
            result.append(aelem.strip())  # remove whitespace
    return ", ".join(result)            

def produce_html_slug(authors, year, title, journal, doi):
    slug = ""
    slug += (authors)
    slug += (f" ({year}): ")
    slug += (title)
    slug += (", ")
    slug += (f'<em class="references">{journal}</em>, ')
    slug += (f'doi: <a class="references" href=http://dx.doi.org/{doi}>{doi}</a>')
    return slug

def send_to_html_file(filname, htmlinput):
    page = """<!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="utf-8">
        <title>Publications.brian</title>
        <style>
        p {
        color: red;
        text-align: center;
        } 
        </style>
    </head>
    <body>
    <h1> Publications </h1>
    <ul>"""
    for h in htmlinput:
        page += f"<li>{h}</li>"
    page += "</ul>"
    page += "</body></html>"
    with open(filname, "w") as file:
        file.write(page)
    print(f"COMPLETE: {filname}")

def send_to_html_file_by_dict(filname, htmlinput):
    """This function expects htmlinput to be organized into a dict,
        the keys of the dict will be sub-headings, and then the value (a list)
        will be the list entries.
    """
    assert isinstance(htmlinput, dict)
    page = get_pre_html()
    # page = """<!DOCTYPE html>
    # <html lang="en">
    # <head>
    #     <meta charset="utf-8">
    #     <title>Am I HTML already?</title>
    # </head>
    # <body>
    # <h1> Publications </h1>
    # """
    for h in htmlinput:
        page += f'<h2 class="references">{h}</h2><ul>'
        for hentry in htmlinput[h]:
            page += f'<li class="references">{hentry}</li>'
        page += "</ul>"
    # page += "</body></html>"
    page += get_post_html()
    with open(filname, "w") as file:
        file.write(page)
    print(f"COMPLETE: {filname}")

def read_bib(fil): 
    return bibtexparser.parse_file(fil)

def check_bib(bibobj):
    print(f"Parsed {len(bibobj.blocks)} blocks, including:"
      f"\n\t{len(bibobj.entries)} entries"
      f"\n\t{len(bibobj.comments)} comments"
      f"\n\t{len(bibobj.strings)} strings and"
      f"\n\t{len(bibobj.preambles)} preambles")
    
def clean_doi(d):
    if d is None:
        return "NA"
    if not isinstance(d, str): 
        d = d.value
    else:
        print(type(d))
    r = d.removeprefix("https://doi.org/")
    r = r.removeprefix("doi:")
    return r

def get_items(bibobj, by_year=None):
    if by_year:
        pub_list_items = {}
    else:
        pub_list_items = []
    for entry in bibobj.entries:
        auField = produce_author_field(entry.get('author').value)
        if "\\" in auField:
            auField = LatexNodes2Text().latex_to_text(auField)
        titleField = entry.get("title").value
        titleField = LatexNodes2Text().latex_to_text(titleField)
        jField = entry.get("journal")
        if jField is None:
            if entry.get("booktitle") is not None:
                jField = entry.get("booktitle").value
            elif entry.entry_type == "techreport":
                jField = f"{entry.get("institution").value} Tech. Rep."
        else:
            jField = jField.value
        yrField = entry.get('year').value
        doiField = clean_doi(entry.get("doi"))
        if doiField is not None:
            doiField = doiField
            print(doiField)
        html = produce_html_slug(auField, yrField, titleField, jField, doiField)
        if by_year:
            if yrField not in pub_list_items.keys():
                pub_list_items[yrField] = []
            pub_list_items[yrField] += [html,]
            # print(f"{yrField = }, {pub_list_items[yrField]}")
        else:
            pub_list_items.append(html)
    return pub_list_items


def get_pre_html():
    return """
            <!DOCTYPE HTML>
            <html>

            <head>
                <title>publications.brian</title>
                <link href="css/bibbase_custom.css" rel="stylesheet">

                <script type="application/x-javascript">
                addEventListener("load", function() { setTimeout(hideURLbar, 0);
            }, false); function hideURLbar(){ window.scrollTo(0,1); }
                </script>
            <script src="js/jquery.min.js"></script>

            <link href="css/bootstrap.css" rel="stylesheet" type="text/css" media="all">
            <link href="css/style.css" rel="stylesheet" type="text/css" media="all" />
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
            <meta name="keywords" content="Climate, Clouds, GCM" />
            <link href='http://fonts.googleapis.com/css?family=Lato:100,300,400,700,900' rel='stylesheet' type='text/css'>
            <script src="https://use.fontawesome.com/0745a66b38.js"></script>

            </head>

            <body>
            <!-- header -->
            <div id="nav-placeholder">
            <script>
            $.get("navigation.html", function(data){
                $("#nav-placeholder").replaceWith(data);
            });
            </script>
            </div>
            <!-- header -->


            <!-- very helpful: -->
            <!-- https://threejs.org/docs/#Manual/Getting_Started/How_to_run_things_locally -->
                    <div class="head-center">
                        <p><a
                    href="provide-files/brian_medeiros_CV.pdf">CV <i
                    class="fa fa-download" aria-hidden="true"></i>
                    </a></p>
                    </div>
                    <div class="clearfix"> </div>
                    </div> 
                    <div class="clearfix"> </div>
                    </div> 

                    
            <div class="clearfix"> </div>
            <div class="references">
            """

def get_post_html():
    return """
            </div>
            <div class="clearfix"> </div>

            <!-- footer -->
            <div class="footer">
            <div id="footer-placeholder">
            <script>
            $.get("footer.html", function(data){
            $("#footer-placeholder").replaceWith(data);
            });
            </script>
            </div>
            </div>
            <!-- footer -->
            </body>
            </html>
            """

def main(f, ofil):
    library = read_bib(f)
    organize_by_year = True
    pub_list = get_items(library, by_year=organize_by_year)
    if organize_by_year:
        pub_list = dict(reversed(sorted(pub_list.items())))
        send_to_html_file_by_dict(ofil, pub_list)
    else:
        send_to_html_file(ofil, pub_list)



if __name__ == "__main__":
    parser = argparse.ArgumentParser(description='Convert .bib file entries to HTML page')
    parser.add_argument('input_file', help='input .bib file')
    parser.add_argument('output_file', help='output .html file')
    args = vars(parser.parse_args())
    main(args['input_file'], args['output_file'])
    # outfile = "/Users/brianpm/Code/brianpm.github.io/bibtoweb/publications.html"

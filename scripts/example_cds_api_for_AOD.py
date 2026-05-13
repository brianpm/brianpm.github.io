import cdsapi

dataset = "satellite-aerosol-properties"
request = {
    "time_aggregation": "monthly_average",
    "variable": "aerosol_optical_depth",
    "sensor_on_satellite": ["slstr_on_sentinel_3a"],
    "algorithm": ["ens"],
    "year": [
        "2017", "2018", "2019",
        "2020", "2021", "2022",
        "2023", "2024", "2025"
    ],
    "month": [
        "01", "02", "03",
        "04", "05", "06",
        "07", "08", "09",
        "10", "11", "12"
    ],
    "version": ["v2_4"]
}

client = cdsapi.Client()
client.retrieve(dataset, request).download()

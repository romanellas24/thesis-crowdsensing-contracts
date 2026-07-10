import csv
import json

def calcola_limiti_geografici(percorso_file):
    # Inizializziamo i valori con infinito (positivo e negativo) per trovare i veri estremi
    min_lat = float('inf')
    max_lat = float('-inf')
    min_lon = float('inf')
    max_lon = float('-inf')

    # Contatore per tenere traccia delle righe elaborate (opzionale, utile per dataset enormi)
    righe_elaborate = 0

    print("Inizio l'analisi del dataset. Potrebbe volerci un po' per file molto grandi...")

    with open(percorso_file, mode='r', encoding='utf-8') as file_csv:
        lettore = csv.DictReader(file_csv)

        for riga in lettore:
            polyline_str = riga.get('POLYLINE', '[]')

            # Saltiamo le righe vuote o con dati mancanti
            if not polyline_str or polyline_str == '[]' or riga.get('MISSING_DATA') == 'True':
                continue

            try:
                # Convertiamo la stringa in una vera e propria lista di Python
                coordinate = json.loads(polyline_str)

                for punto in coordinate:
                    lon, lat = punto[0], punto[1]

                    # Aggiorniamo i minimi e i massimi
                    if lat < min_lat: min_lat = lat
                    if lat > max_lat: max_lat = lat
                    if lon < min_lon: min_lon = lon
                    if lon > max_lon: max_lon = lon

            except (json.JSONDecodeError, ValueError, IndexError):
                # Ignoriamo le righe con formattazione errata
                continue

            righe_elaborate += 1
            if righe_elaborate % 100000 == 0:
                print(f"Elaborate {righe_elaborate} traiettorie...")

    return min_lat, max_lat, min_lon, max_lon

# --- ESECUZIONE ---
file_dataset = 'porto_500.csv'
minimi_massimi = calcola_limiti_geografici(file_dataset)

print("\n--- RISULTATI FINALI ---")
print(f"Latitudine Minima:  {minimi_massimi[0]}")
print(f"Latitudine Massima: {minimi_massimi[1]}")
print(f"Longitudine Minima: {minimi_massimi[2]}")
print(f"Longitudine Massima:{minimi_massimi[3]}")
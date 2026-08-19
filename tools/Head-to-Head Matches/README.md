# World Aces H2H Statistics

A Jupyter Notebook tool for collecting World Aces match data and viewing Head-to-Head statistics between teams.

The project downloads match data directly from the World Aces API, builds a local match dataset, and lets you browse H2H matches and statistics without repeatedly requesting the API for every opponent.

## Files

* `H2HMatches.ipynb` — main notebook
* `cell1.py` — match data collection
* `cell2.py` — H2H match browser
* `cell3.py` — H2H summary/statistics
* `requirements.txt` — required Python packages

## Requirements

You need:

* Python 3
* Jupyter Notebook or JupyterLab
* A valid World Aces Bearer token


### 1. Install Python

If you do not already have Python installed, download and install Python 3 from the official Python website.

During installation on Windows, make sure to enable **Add Python to PATH**.

### 2. Install Jupyter Notebook

Open a terminal or command prompt and run:

```bash
pip install notebook
```

You can also install JupyterLab instead:

```bash
pip install jupyterlab
```

### 3. Install the project dependencies

Open a terminal in the project folder and run:

```bash
pip install -r requirements.txt
```

Alternatively, the packages can be installed from inside Jupyter Notebook with:

```python
%pip install -r requirements.txt
```

## How to run

Open a terminal in the project folder and run:

```bash
jupyter notebook
```

Jupyter will open in your web browser.

Open:

```text
H2HMatches.ipynb
```

Run the cells in order.

### Cell 1 — Collect match data

Cell 1 asks for your World Aces Bearer token and then provides the Team ID and date-range controls.

Enter your Team ID, choose the period you want, and click **Fetch Matches**.

The script:

1. Finds the team's matches in the selected period.
2. Downloads the full JSON for each match.
3. Builds the match dataset.
4. Saves the full dataset as `match_statistics.csv`.
5. Displays the first five rows.

The complete dataset remains available in `df` for the following cells.
<img width="1296" height="524" alt="1" src="https://github.com/user-attachments/assets/579087e1-658f-4ec7-b841-0ee8da28ff53" />
<img width="1296" height="389" alt="2" src="https://github.com/user-attachments/assets/90fb8051-7d27-4b84-9dfd-aad0117f1e79" />

### Cell 2 — H2H Match Browser

Cell 2 uses the dataset already collected by Cell 1.

Select an opponent, competition, and number of matches to view the H2H match history.

No additional API requests are made by Cell 2.
<img width="1296" height="524" alt="3" src="https://github.com/user-attachments/assets/dd7208e5-b115-4d29-b63a-c52981553204" />

### Cell 3 — H2H Summary

Cell 3 generates the H2H statistics dashboard, including overall record, match statistics, totals, and competition breakdown.
<img width="1296" height="405" alt="4" src="https://github.com/user-attachments/assets/12f10fc4-f4bf-450b-8915-09cf5004a94a" />
<img width="1296" height="388" alt="7" src="https://github.com/user-attachments/assets/4797392d-f336-477c-8b6c-b5f1c1e726ae" />
<img width="1296" height="410" alt="5" src="https://github.com/user-attachments/assets/76c3bf17-d678-4d06-a14f-1b06c1e841d6" />
<img width="1296" height="524" alt="6" src="https://github.com/user-attachments/assets/cc9d6a84-e86a-4a3a-a812-912dd926cc68" />

## Important

You need to run Cell 1 before Cell 2 and Cell 3 because they use the `df` and `TEAM_ID` created by Cell 1.

Do not share your Bearer token or commit it to GitHub.

## Updating an existing dataset

The match dataset can be saved as `match_statistics.csv` and reused for later H2H analysis.

Future versions may add automatic checking for new matches so existing datasets can be updated without downloading the same matches again.


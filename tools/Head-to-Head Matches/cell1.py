# ============================================================
# CELL 0 — IMPORTS
# ============================================================

import requests
import pandas as pd
import ipywidgets as widgets

from getpass import getpass
from IPython.display import display, clear_output, HTML

from datetime import datetime, timezone, timedelta

# ============================================================
# CELL 1 — MATCH DATA COLLECTION
# ============================================================
# ============================================================
# CONFIG
# ============================================================

BASE = "https://api.worldaces.site"

TOKEN = getpass("Bearer token: ").strip()

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Accept": "application/json"
}

# ============================================================
# HELPERS
# ============================================================

def num(x):
    """
    Return numeric values as-is.
    Return 0 for missing/non-numeric values.
    """

    return x if isinstance(x, (int, float)) else 0


# ============================================================
# EXTRACT ONE MATCH
# ============================================================

def get_match_record(data):

    home = data.get("homeTeam", {})
    away = data.get("awayTeam", {})


    # --------------------------------------------------------
    # RALLY METRICS TOTAL
    # --------------------------------------------------------

    rally_total = (
        data
        .get("rallyMetrics", {})
        .get("total", {})
    )

    ht = rally_total.get("home", {})
    at = rally_total.get("away", {})


    # --------------------------------------------------------
    # BREAKDOWN
    # --------------------------------------------------------

    breakdown = data.get(
        "breakdown",
        {}
    )

    hb = breakdown.get(
        "home",
        {}
    )

    ab = breakdown.get(
        "away",
        {}
    )


    # --------------------------------------------------------
    # SET SCORES
    # --------------------------------------------------------

    home_sets = (
        data
        .get("results", {})
        .get("home", [])
    )

    away_sets = (
        data
        .get("results", {})
        .get("away", [])
    )


    # --------------------------------------------------------
    # MATCH RECORD
    # --------------------------------------------------------

    return {

        # ====================================================
        # MATCH
        # ====================================================

        "match_id": data.get("id"),

        "scheduledDate": data.get(
            "scheduledDate"
        ),

        "status": data.get(
            "status"
        ),

        # Competition
        "competition": (
            data
            .get("competition", {})
            .get("type")
        ),


        # ====================================================
        # TEAMS
        # ====================================================

        "home_team": home.get(
            "name"
        ),

        "home_team_id": home.get(
            "id"
        ),

        "away_team": away.get(
            "name"
        ),

        "away_team_id": away.get(
            "id"
        ),


        # ====================================================
        # FINAL SCORE
        # ====================================================

        "home_score": data.get(
            "homeScore"
        ),

        "away_score": data.get(
            "awayScore"
        ),


        # ====================================================
        # SET SCORES
        # ====================================================

        "home_set_scores": home_sets,

        "away_set_scores": away_sets,


        # ====================================================
        # RALLY METRICS — TOTAL
        # ====================================================

        # Serves
        "home_serves": num(
            ht.get("serves")
        ),

        "away_serves": num(
            at.get("serves")
        ),


        # First-ball sideout
        "home_fbso_pct": num(
            ht.get("fbsoPct")
        ),

        "away_fbso_pct": num(
            at.get("fbsoPct")
        ),

        "home_fbso_wins": num(
            ht.get("fbsoWins")
        ),

        "away_fbso_wins": num(
            at.get("fbsoWins")
        ),


        # Receptions
        "home_receptions": num(
            ht.get("receptions")
        ),

        "away_receptions": num(
            at.get("receptions")
        ),


        # Sideout
        "home_sideout_pct": num(
            ht.get("sideoutPct")
        ),

        "away_sideout_pct": num(
            at.get("sideoutPct")
        ),

        "home_sideout_wins": num(
            ht.get("sideoutWins")
        ),

        "away_sideout_wins": num(
            at.get("sideoutWins")
        ),


        # Breakpoint
        "home_breakpoint_pct": num(
            ht.get("breakpointPct")
        ),

        "away_breakpoint_pct": num(
            at.get("breakpointPct")
        ),

        "home_breakpoint_wins": num(
            ht.get("breakpointWins")
        ),

        "away_breakpoint_wins": num(
            at.get("breakpointWins")
        ),


        # Modified metrics
        "home_mod_fbso_pct": num(
            ht.get("modFbsoPct")
        ),

        "away_mod_fbso_pct": num(
            at.get("modFbsoPct")
        ),

        "home_mod_receptions": num(
            ht.get("modReceptions")
        ),

        "away_mod_receptions": num(
            at.get("modReceptions")
        ),

        "home_mod_sideout_pct": num(
            ht.get("modSideoutPct")
        ),

        "away_mod_sideout_pct": num(
            at.get("modSideoutPct")
        ),

        "home_mod_sideout_wins": num(
            ht.get("modSideoutWins")
        ),

        "away_mod_sideout_wins": num(
            at.get("modSideoutWins")
        ),


        # Service errors received
        "home_service_errors_received": num(
            ht.get("serviceErrorsReceived")
        ),

        "away_service_errors_received": num(
            at.get("serviceErrorsReceived")
        ),


        # ====================================================
        # BREAKDOWN
        # ====================================================

        "home_aces": num(
            hb.get("aces")
        ),

        "away_aces": num(
            ab.get("aces")
        ),

        "home_kills": num(
            hb.get("kills")
        ),

        "away_kills": num(
            ab.get("kills")
        ),

        "home_block_points": num(
            hb.get("blockPoints")
        ),

        "away_block_points": num(
            ab.get("blockPoints")
        ),

        "home_opponent_errors": num(
            hb.get("opponentErrors")
        ),

        "away_opponent_errors": num(
            ab.get("opponentErrors")
        ),
    }


# ============================================================
# UI
# ============================================================

team_id_input = widgets.Text(
    description="Team ID:",
    placeholder="Enter team ID",
    layout=widgets.Layout(
        width="500px"
    )
)


period_dropdown = widgets.Dropdown(
    options=[
        ("Last 7 days", 7),
        ("Last 15 days",15),
        ("Last 30 days", 30),
        ("Last 3 months", 90),
        ("Custom", "custom")
    ],
    value=90,
    description="Period:",
    layout=widgets.Layout(
        width="500px"
    )
)


start_date = widgets.DatePicker(
    description="From:",
    layout=widgets.Layout(
        width="500px"
    )
)


end_date = widgets.DatePicker(
    description="To:",
    layout=widgets.Layout(
        width="500px"
    )
)


fetch_button = widgets.Button(
    description="Fetch Matches",
    button_style="primary",
    layout=widgets.Layout(
        width="150px"
    )
)


output = widgets.Output()


# ============================================================
# DATE VISIBILITY
# ============================================================

def update_date_visibility(change=None):

    if period_dropdown.value == "custom":

        start_date.layout.display = ""
        end_date.layout.display = ""

    else:

        start_date.layout.display = "none"
        end_date.layout.display = "none"


update_date_visibility()


period_dropdown.observe(
    update_date_visibility,
    names="value"
)


# ============================================================
# FETCH MATCHES
# ============================================================

def fetch_matches(button):

    global df
    global TEAM_ID


    with output:

        clear_output()


        # ----------------------------------------------------
        # TEAM ID
        # ----------------------------------------------------

        TEAM_ID = team_id_input.value.strip()


        if not TEAM_ID:

            print(
                "❌ Please enter a Team ID."
            )

            return


        # ----------------------------------------------------
        # DETERMINE DATE RANGE
        # ----------------------------------------------------

        today = datetime.now(
            timezone.utc
        ).date()


        if period_dropdown.value == "custom":

            if start_date.value is None:

                print(
                    "❌ Please select a start date."
                )

                return


            if end_date.value is None:

                print(
                    "❌ Please select an end date."
                )

                return


            start = start_date.value
            end = end_date.value


        else:

            days = period_dropdown.value

            end = today

            start = (
                today
                - timedelta(days=days)
            )


        # ----------------------------------------------------
        # VALIDATE DATES
        # ----------------------------------------------------

        if start > end:

            print(
                "❌ Invalid date range.\n"
                "'From' must be before or equal "
                "to 'To'."
            )

            return


        if end > today:

            print(
                "❌ The end date cannot be "
                "in the future."
            )

            return


        START_DATE = start.strftime(
            "%Y-%m-%d"
        )

        END_DATE = end.strftime(
            "%Y-%m-%d"
        )


        # ----------------------------------------------------
        # SHOW SEARCH
        # ----------------------------------------------------

        print(
            "Searching matches...\n"
        )

        print(
            f"Team ID: {TEAM_ID}"
        )

        print(
            f"From:    {START_DATE}"
        )

        print(
            f"To:      {END_DATE}\n"
        )


        # ====================================================
        # GET MATCH LIST
        # ====================================================

        url = (
            f"{BASE}/team/matches-by-day/"
            f"{TEAM_ID}"
            f"?startDate="
            f"{START_DATE}T00:00:00.000Z"
            f"&endDate="
            f"{END_DATE}T23:59:59.999Z"
            f"&type=ALL"
        )


        try:

            response = requests.get(
                url,
                headers=HEADERS,
                timeout=30
            )

            response.raise_for_status()

            matches = (
                response
                .json()
                .get("matches", [])
            )


        except requests.RequestException as e:

            print(
                "❌ API error while getting "
                f"matches:\n{e}"
            )

            return


        print(
            f"Matches found: {len(matches)}\n"
        )


        if not matches:

            df = pd.DataFrame()

            print(
                "No matches found."
            )

            return


        # ====================================================
        # GET FULL MATCH DATA
        # ====================================================

        records = []


        for i, match in enumerate(
            matches,
            1
        ):

            match_id = match.get(
                "id"
            )


            try:

                response = requests.get(
                    f"{BASE}/match/{match_id}",
                    headers=HEADERS,
                    timeout=30
                )

                response.raise_for_status()

                data = response.json()


                records.append(
                    get_match_record(data)
                )


                print(
                    f"{i}/{len(matches)} "
                    f"✓ {match_id}"
                )


            except requests.RequestException as e:

                print(
                    f"{i}/{len(matches)} "
                    f"❌ {match_id}: {e}"
                )


        # ====================================================
        # CREATE DATAFRAME
        # ====================================================

        df = pd.DataFrame(
            records
        )


        if df.empty:

            print(
                "\n❌ No full match data "
                "could be collected."
            )

            return


        # ====================================================
        # FORMAT
        # ====================================================

        df["scheduledDate"] = pd.to_datetime(
            df["scheduledDate"],
            utc=True,
            errors="coerce"
        )


        df = (
            df
            .sort_values(
                "scheduledDate"
            )
            .reset_index(
                drop=True
            )
        )


        # ====================================================
        # SAVE
        # ====================================================

        df.to_csv(
            "match_statistics.csv",
            index=False
        )


        # ====================================================
        # RESULT
        # ====================================================

        print(
            f"\n✅ Saved full dataset: "
            f"{len(df)} matches"
        )


        print(
            "\nCompetition distribution:"
        )


        print(
            df["competition"]
            .fillna("UNKNOWN")
            .value_counts()
        )


        display(df.head(5))


# ============================================================
# BUTTON EVENT
# ============================================================

fetch_button.on_click(
    fetch_matches
)


# ============================================================
# DISPLAY UI
# ============================================================

display(
    team_id_input,
    period_dropdown,
    start_date,
    end_date,
    fetch_button,
    output
)
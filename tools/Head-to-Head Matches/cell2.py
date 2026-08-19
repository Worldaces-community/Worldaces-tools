# ============================================================
# CELL 2 — H2H MATCH BROWSER
# ============================================================
#
# Uses the complete dataset created by CELL 1.
#
# IMPORTANT:
#   - No API requests are made here.
#   - Team 1 comes from TEAM_ID in Cell 1.
#   - User only selects the opponent.
#   - Competition filtering is done locally.
#
# Features:
#   • Opponent dropdown
#   • Competition dropdown + record counts
#   • All competitions
#   • Last 5 / Last 10 / All H2H
#   • Game-style match headers
#   • Set scores
#   • Match date
#   • View Match link
#   • Expandable details
#   • Attack / Block / Serve / Opponent Error
#   • Calculated Total
#   • Sideout / Breakpoint percentages
# ============================================================


# ============================================================
# CHECK CELL 1
# ============================================================

if "df" not in globals() or df.empty:

    print("❌ No match dataset found.")
    print("Run Cell 1 first.")

elif "TEAM_ID" not in globals():

    print("❌ TEAM_ID was not found.")
    print("Run Cell 1 first.")

else:

    # ========================================================
    # HELPERS
    # ========================================================

    def clean_id(value):

        if pd.isna(value):
            return ""

        return str(value).strip()


    def num(value):

        try:
            return int(float(value))
        except:
            return 0


    def pct(value):

        try:
            return float(value)
        except:
            return 0.0


    def competition_name(row):

        value = row.get("competition")

        if pd.isna(value):
            return "UNKNOWN"

        value = str(value).strip()

        return value if value else "UNKNOWN"


    # ========================================================
    # SET SCORE FORMATTER
    # ========================================================

    def parse_scores(value):

        if value is None:
            return []

        if isinstance(value, (list, tuple)):
            return list(value)

        text = str(value).strip()

        if not text:
            return []

        text = (
            text
            .replace("[", "")
            .replace("]", "")
            .replace("(", "")
            .replace(")", "")
        )

        result = []

        for item in text.split(","):

            item = item.strip()

            if not item:
                continue

            try:
                result.append(
                    int(float(item))
                )
            except:
                pass

        return result


    def format_sets(home_scores, away_scores):

        home = parse_scores(home_scores)
        away = parse_scores(away_scores)

        result = []

        for h, a in zip(home, away):

            result.append(
                f"""
                <span class="h2h-set-score">
                    {h} - {a}
                </span>
                """
            )

        return "".join(result)


    # ========================================================
    # GET ALL OPPONENTS
    # ========================================================

    def get_opponents():
    
        team_id = clean_id(TEAM_ID)
    
        opponents = {}
    
        for _, row in df.iterrows():
    
            home_id = clean_id(
                row.get("home_team_id")
            )
    
            away_id = clean_id(
                row.get("away_team_id")
            )
    
            home_name = row.get(
                "home_team"
            )
    
            away_name = row.get(
                "away_team"
            )
    
            # Team 1 is home
            if home_id == team_id:
    
                if away_id:
    
                    if away_id not in opponents:
    
                        opponents[away_id] = {
                            "name": str(away_name),
                            "count": 0
                        }
    
                    opponents[away_id]["count"] += 1
    
            # Team 1 is away
            elif away_id == team_id:
    
                if home_id:
    
                    if home_id not in opponents:
    
                        opponents[home_id] = {
                            "name": str(home_name),
                            "count": 0
                        }
    
                    opponents[home_id]["count"] += 1
    
        return sorted(
            opponents.items(),
            key=lambda x: x[1]["name"].lower()
        )

    # ========================================================
    # UI
    # ========================================================
    
    h2h_opponent = widgets.Dropdown(
        description="Opponent:",
        options=[],
        layout=widgets.Layout(width="520px"),
        style={"description_width": "100px"}
    )
    
    h2h_competition = widgets.Dropdown(
        description="Competition:",
        options=[],
        layout=widgets.Layout(width="520px"),
        style={"description_width": "100px"}
    )
    
    h2h_match_count = widgets.Dropdown(
        description="Matches:",
        options=[
            ("Last 5", 5),
            ("Last 10", 10),
            ("All H2H", "all")
        ],
        value=10,
        layout=widgets.Layout(width="520px"),
        style={"description_width": "100px"}
    )

    h2h_show_button = widgets.Button(
        description="Show H2H",
        button_style="primary",
        layout=widgets.Layout(
            width="120px"
        )
    )


    h2h_save_button = widgets.Button(
        description="Save H2H CSV",
        disabled=True,
        layout=widgets.Layout(
            width="135px"
        )
    )


    h2h_output = widgets.Output()


    # ========================================================
    # UPDATE OPPONENTS
    # ========================================================

    opponents = get_opponents()

    h2h_opponent.options = [
    
        (
    
            f"{data['name']} ({data['count']})",
    
            opponent_id
    
        )
    
        for opponent_id, data
    
        in opponents
    
    ]
    # ========================================================
    # FILTER H2H
    # ========================================================

    def get_h2h_matches():

        team_id = clean_id(
            TEAM_ID
        )

        opponent_id = clean_id(
            h2h_opponent.value
        )


        if not opponent_id:

            return pd.DataFrame()


        matches = df[
            (
                (
                    df[
                        "home_team_id"
                    ].astype(str)
                    == team_id
                )
                &
                (
                    df[
                        "away_team_id"
                    ].astype(str)
                    == opponent_id
                )
            )
            |
            (
                (
                    df[
                        "home_team_id"
                    ].astype(str)
                    == opponent_id
                )
                &
                (
                    df[
                        "away_team_id"
                    ].astype(str)
                    == team_id
                )
            )
        ].copy()


        return matches


    # ========================================================
    # UPDATE COMPETITIONS
    # ========================================================

    def update_competitions(
        change=None
    ):

        matches = get_h2h_matches()


        if matches.empty:

            h2h_competition.options = []

            return


        counts = (
            matches[
                "competition"
            ]
            .fillna("UNKNOWN")
            .astype(str)
            .value_counts()
        )


        options = [
            (
                f"All competitions ({len(matches)})",
                "ALL"
            )
        ]


        for name, count in counts.items():

            options.append(
                (
                    f"{name} ({count})",
                    name
                )
            )


        h2h_competition.options = options

        h2h_competition.value = "ALL"


    h2h_opponent.observe(
        update_competitions,
        names="value"
    )


    update_competitions()


    # ========================================================
    # MATCH STATISTICS
    # ========================================================

    def get_stats(row, side):

        attack = num(
            row.get(
                f"{side}_kills",
                0
            )
        )

        block = num(
            row.get(
                f"{side}_block_points",
                0
            )
        )

        serve = num(
            row.get(
                f"{side}_aces",
                0
            )
        )

        opponent_error = num(
            row.get(
                f"{side}_opponent_errors",
                0
            )
        )


        total = (
            attack
            + block
            + serve
            + opponent_error
        )


        return {
            "attack": attack,
            "block": block,
            "serve": serve,
            "opponent_error": opponent_error,
            "total": total
        }


    # ========================================================
    # STAT ROW
    # ========================================================

    def make_stat_row(
        label,
        left,
        right
    ):

        left = num(left)
        right = num(right)


        if left > right:

            left_class = "winner"
            right_class = "normal"

        elif right > left:

            left_class = "normal"
            right_class = "winner"

        else:

            left_class = "tie"
            right_class = "tie"


        return f"""

        <div class="h2h-stat-row">

            <div class="h2h-stat-value {left_class}">
                {left}
            </div>

            <div class="h2h-stat-label">
                {label}
            </div>

            <div class="h2h-stat-value {right_class}">
                {right}
            </div>

        </div>

        """


    # ========================================================
    # PERCENTAGE ROW
    # ========================================================

    def make_pct_row(
        label,
        left,
        right
    ):

        left = pct(left)
        right = pct(right)


        if left > right:

            left_class = "winner"
            right_class = "normal"

        elif right > left:

            left_class = "normal"
            right_class = "winner"

        else:

            left_class = "tie"
            right_class = "tie"


        return f"""

        <div class="h2h-stat-row">

            <div class="
                h2h-stat-value
                {left_class}
            ">
                {left:.1f}%
            </div>

            <div class="h2h-stat-label">
                {label}
            </div>

            <div class="
                h2h-stat-value
                {right_class}
            ">
                {right:.1f}%
            </div>

        </div>

        """


    # ========================================================
    # DETAILS HTML
    # ========================================================

    def create_details_html(row):

        home_name = str(
            row.get(
                "home_team",
                "Home"
            )
        )

        away_name = str(
            row.get(
                "away_team",
                "Away"
            )
        )


        home = get_stats(
            row,
            "home"
        )

        away = get_stats(
            row,
            "away"
        )


        return f"""

        <style>

        .h2h-details {{
                background:#11173f;
                border:1px solid #303879;
                border-radius:12px;
                padding:18px;
                margin:0 auto 18px auto;
                color:#f4f5ff;
                font-family:Arial,sans-serif;
                width:90%;
                box-sizing:border-box;
        }}


        .h2h-details-title {{
            text-align:center;
            font-size:21px;
            font-weight:800;
            margin-bottom:16px;
        }}


        .h2h-details-teams {{
            display:grid;
            grid-template-columns:1fr 120px 1fr;
            align-items:center;
            width:90%;
            margin:0 auto 6px auto;
        }}


        .h2h-details-team-left {{
            text-align:right;
            padding-right:15px;
            font-size:16px;
            font-weight:800;
        }}


        .h2h-details-team-right {{
            text-align:left;
            padding-left:15px;
            font-size:16px;
            font-weight:800;
        }}


        .h2h-section {{
            background:#181e4e;
            border-radius:10px;
            padding:8px 12px;
            margin-top:12px;
        }}


        .h2h-section-title {{
            text-align:center;
            font-size:17px;
            font-weight:800;
            padding:8px;
        }}


        .h2h-stat-row {{
            display:grid;
            grid-template-columns:1fr 150px 1fr;
            align-items:center;
            min-height:52px;
            border-top:1px solid #2b326b;
        }}


        .h2h-stat-value {{
            width:54px;
            padding:7px 4px;
            border-radius:4px;
            text-align:center;
            font-size:18px;
            font-weight:800;
            background:#373d6d;
            color:#b4badf;
        }}


        .h2h-stat-row
        .h2h-stat-value:first-child {{
            justify-self:end;
            margin-right:16px;
        }}


        .h2h-stat-row
        .h2h-stat-value:last-child {{
            justify-self:start;
            margin-left:16px;
        }}


        .h2h-stat-label {{
            text-align:center;
            font-size:14px;
            font-weight:700;
        }}


        .h2h-stat-value.winner {{
            background:#f39a18;
            color:white;
        }}


        .h2h-stat-value.tie {{
            background:#458bb5;
            color:white;
        }}

        </style>


        <div class="h2h-details">

            <div class="h2h-details-title">
                Match Stats
            </div>


            <div class="h2h-details-teams">

                <div class="
                    h2h-details-team-left
                ">
                    {home_name}
                </div>

                <div></div>

                <div class="
                    h2h-details-team-right
                ">
                    {away_name}
                </div>

            </div>


            <div class="h2h-section">

                {make_stat_row(
                    "ATTACK",
                    home["attack"],
                    away["attack"]
                )}

                {make_stat_row(
                    "BLOCK",
                    home["block"],
                    away["block"]
                )}

                {make_stat_row(
                    "SERVE",
                    home["serve"],
                    away["serve"]
                )}

                {make_stat_row(
                    "OPPONENT ERROR",
                    home["opponent_error"],
                    away["opponent_error"]
                )}

                {make_stat_row(
                    "TOTAL",
                    home["total"],
                    away["total"]
                )}

            </div>


            <div class="h2h-section">

                <div class="
                    h2h-section-title
                ">
                    Sideout &amp; Breakpoint
                </div>


                {make_pct_row(
                    "BREAKPOINT",
                    row.get(
                        "home_breakpoint_pct",
                        0
                    ),
                    row.get(
                        "away_breakpoint_pct",
                        0
                    )
                )}


                {make_pct_row(
                    "SIDEOUT",
                    row.get(
                        "home_sideout_pct",
                        0
                    ),
                    row.get(
                        "away_sideout_pct",
                        0
                    )
                )}


                {make_pct_row(
                    "MOD. SIDEOUT",
                    row.get(
                        "home_mod_sideout_pct",
                        0
                    ),
                    row.get(
                        "away_mod_sideout_pct",
                        0
                    )
                )}


                {make_pct_row(
                    "FBSO",
                    row.get(
                        "home_fbso_pct",
                        0
                    ),
                    row.get(
                        "away_fbso_pct",
                        0
                    )
                )}


                {make_pct_row(
                    "MOD. FBSO",
                    row.get(
                        "home_mod_fbso_pct",
                        0
                    ),
                    row.get(
                        "away_mod_fbso_pct",
                        0
                    )
                )}

            </div>

        </div>

        """


    # ========================================================
    # SHOW H2H
    # ========================================================

    def show_h2h(button):

        global h2h


        with h2h_output:

            clear_output(
                wait=True
            )


            matches = get_h2h_matches()


            if matches.empty:

                h2h_save_button.disabled = True

                display(
                    widgets.HTML(
                        value="""
                        <div style="
                            padding:15px;
                            margin-top:15px;
                            background:#171d50;
                            border-radius:10px;
                            color:#ff8d8d;
                            font-weight:700;
                        ">
                        ❌ No H2H matches found.
                        </div>
                        """
                    )
                )

                return


            # ------------------------------------------------
            # COMPETITION FILTER
            # ------------------------------------------------

            selected_competition = (
                h2h_competition.value
            )


            if (
                selected_competition
                and selected_competition != "ALL"
            ):

                matches = matches[
                    matches[
                        "competition"
                    ]
                    .fillna("UNKNOWN")
                    .astype(str)
                    == str(
                        selected_competition
                    )
                ]


            # ------------------------------------------------
            # SORT NEWEST FIRST
            # ------------------------------------------------

            matches = (
                matches
                .sort_values(
                    "scheduledDate",
                    ascending=False
                )
                .reset_index(drop=True)
            )


            # ------------------------------------------------
            # LAST 5 / LAST 10
            # ------------------------------------------------

            selected_count = (
                h2h_match_count.value
            )


            if selected_count != "all":

                matches = matches.head(
                    int(selected_count)
                )


            # ------------------------------------------------
            # STORE CURRENT H2H
            # ------------------------------------------------

            h2h = matches.copy()

            h2h_save_button.disabled = (
                matches.empty
            )


            if matches.empty:

                display(
                    widgets.HTML(
                        value="""
                        <div style="
                            padding:15px;
                            margin-top:15px;
                            background:#171d50;
                            border-radius:10px;
                            color:#ff8d8d;
                            font-weight:700;
                        ">
                        ❌ No matches for this
                        competition.
                        </div>
                        """
                    )
                )

                return


            # ------------------------------------------------
            # RESULT COUNT
            # ------------------------------------------------

            display(
                widgets.HTML(
                    value=f"""
                    <div style="
                        margin:18px 0 8px 0;
                        font-size:17px;
                        font-weight:800;
                    ">
                        {len(matches)} H2H matches
                    </div>
                    """
                )
            )


            # =================================================
            # MATCH CARDS
            # =================================================

            for _, row in matches.iterrows():

                home_name = str(
                    row.get(
                        "home_team",
                        "Home"
                    )
                )

                away_name = str(
                    row.get(
                        "away_team",
                        "Away"
                    )
                )


                home_score = num(
                    row.get(
                        "home_score",
                        0
                    )
                )

                away_score = num(
                    row.get(
                        "away_score",
                        0
                    )
                )


                competition = (
                    competition_name(
                        row
                    )
                )


                # ------------------------------------------------
                # DATE
                # ------------------------------------------------

                date_value = row.get(
                    "scheduledDate"
                )


                if pd.notna(
                    date_value
                ):

                    try:

                        date_text = (
                            pd.Timestamp(
                                date_value
                            )
                            .strftime(
                                "%d %b %Y • %H:%M UTC"
                            )
                        )

                    except:

                        date_text = str(
                            date_value
                        )

                else:

                    date_text = ""


                # ------------------------------------------------
                # SETS
                # ------------------------------------------------

                sets_html = format_sets(
                    row.get(
                        "home_set_scores"
                    ),
                    row.get(
                        "away_set_scores"
                    )
                )


                # ------------------------------------------------
                # MATCH LINK
                # ------------------------------------------------

                match_id = str(
                    row.get(
                        "match_id",
                        ""
                    )
                ).strip()


                match_url = (
                    "https://worldaces.site/match/"
                    + match_id
                )


                # ------------------------------------------------
                # MATCH HEADER
                # ------------------------------------------------

                match_header = widgets.HTML(
                    value=f"""

                    <style>

                    .h2h-match-card {{
                        background:#172d37;
                        border:1px solid #29404a;
                        border-radius:4px;
                        padding:18px 20px 16px 20px;
                        margin-top:14px;
                        color:#f4f5fa;
                        font-family:Arial,sans-serif;
                        width:100%;
                        box-sizing:border-box;
                    }}


                    .h2h-competition {{
                        text-align:center;
                        color:#aab2d8;
                        font-size:13px;
                        font-weight:700;
                        text-decoration:underline;
                        margin-bottom:13px;
                    }}


                    .h2h-score-line {{
                        display:flex;
                        justify-content:center;
                        align-items:center;
                        gap:9px;
                    }}


                    .h2h-team {{
                        font-size:25px;
                        font-weight:900;
                        text-transform:uppercase;
                        white-space:nowrap;
                    }}


                    .h2h-team-left {{
                        text-align:right;
                    }}


                    .h2h-team-right {{
                        text-align:left;
                    }}


                    .h2h-score-box {{
                        min-width:39px;
                        padding:5px 8px;
                        background:#f2f3f4;
                        color:#151c30;
                        border-radius:4px;
                        text-align:center;
                        font-size:25px;
                        font-weight:900;
                    }}


                    .h2h-colon {{
                        font-size:24px;
                        font-weight:900;
                    }}


                    .h2h-sets {{
                        display:flex;
                        justify-content:center;
                        flex-wrap:wrap;
                        gap:6px;
                        margin-top:13px;
                    }}


                    .h2h-set-score {{
                        display:inline-block;
                        padding:5px 8px;
                        background:#f0f1f2;
                        color:#172039;
                        border-radius:3px;
                        font-size:12px;
                        font-weight:800;
                    }}


                    .h2h-date {{
                        text-align:center;
                        color:#8992bc;
                        font-size:11px;
                        margin-top:10px;
                    }}


                    .h2h-view {{
                        display:inline-block;
                        margin-top:12px;
                        padding:7px 14px;
                        background:#343f9f;
                        color:white !important;
                        text-decoration:none !important;
                        border-radius:16px;
                        font-size:12px;
                        font-weight:800;
                    }}


                    .h2h-view:hover {{
                        background:#4551b7;
                    }}

                    </style>


                    <div class="h2h-match-card">

                        <div class="h2h-competition">
                            {competition}
                        </div>


                        <div class="h2h-score-line">

                            <div class="
                                h2h-team
                                h2h-team-left
                            ">
                                {home_name}
                            </div>


                            <div class="
                                h2h-score-box
                            ">
                                {home_score}
                            </div>


                            <div class="
                                h2h-colon
                            ">
                                :
                            </div>


                            <div class="
                                h2h-score-box
                            ">
                                {away_score}
                            </div>


                            <div class="
                                h2h-team
                                h2h-team-right
                            ">
                                {away_name}
                            </div>

                        </div>


                        <div class="h2h-sets">
                            {sets_html}
                        </div>


                        <div class="h2h-date">
                            {date_text}
                        </div>


                        <div style="
                            text-align:center;
                        ">

                            <a
                                class="h2h-view"
                                href="{match_url}"
                                target="_blank"
                            >
                                View Match ↗
                            </a>

                        </div>

                    </div>

                    """)


                # ------------------------------------------------
                # DETAILS
                # ------------------------------------------------

                details_output = widgets.Output(layout=widgets.Layout(width="100%"))


                details_button = widgets.Button(
                    description="Details ▼",
                    layout=widgets.Layout(
                        width="110px",
                        height="32px"
                    )
                )


                def toggle_details(
                    button,
                    row=row,
                    details_output=details_output
                ):

                    if (
                        details_output.layout.display
                        == "none"
                    ):

                        details_output.layout.display = ""

                        button.description = (
                            "Details ▲"
                        )


                        with details_output:

                            clear_output(
                                wait=True
                            )

                            display(
                                widgets.HTML(
                                    value=create_details_html(
                                        row
                                    )
                                )
                            )

                    else:

                        details_output.layout.display = "none"

                        button.description = (
                            "Details ▼"
                        )


                details_button.on_click(
                    toggle_details
                )


                # ------------------------------------------------
                # CARD LAYOUT
                # ------------------------------------------------

                actions = widgets.HBox(
                    [
                        details_button
                    ],
                    layout=widgets.Layout(
                        justify_content="center",
                        width="100%",
                        margin="0 0 8px 0"
                    )
                )


                card = widgets.VBox(
                                [
                            
                                    match_header,
                            
                                    actions
                            
                                ],
                            
                                layout=widgets.Layout(
                            
                                    width="100%",
                            
                                    align_items="center"
                            
                                )
                            
                            )


                display(
                    card
                )


                details_output.layout.display = (
                    "none"
                )


                display(
                    details_output
                )


    # ========================================================
    # SAVE
    # ========================================================

    def save_h2h(button):

        if (
            "h2h" not in globals()
            or h2h.empty
        ):

            with h2h_output:

                print(
                    "❌ No H2H dataset to save."
                )

            return


        filename = (
            "h2h_match_statistics.csv"
        )


        h2h.to_csv(
            filename,
            index=False
        )


        with h2h_output:

            print(
                f"✅ Saved: {filename}"
            )


    # ========================================================
    # BUTTON EVENTS
    # ========================================================

    h2h_show_button.on_click(
        show_h2h
    )

    h2h_save_button.on_click(
        save_h2h
    )


    # ========================================================
    # TITLE
    # ========================================================

    display(
        widgets.HTML(
            value="""
            <div style="
                font-size:25px;
                font-weight:900;
                margin:8px 0 18px 0;
            ">
                H2H Match Browser
            </div>
            """
        )
    )


    # ========================================================
    # DISPLAY CONTROLS
    # ========================================================

    display(
        h2h_opponent,
        h2h_competition,
        h2h_match_count,
        widgets.HBox(
            [
                h2h_show_button,
                h2h_save_button
            ],
            layout=widgets.Layout(
                gap="8px",
                margin="5px 0 12px 0"
            )
        ),
        h2h_output
    )
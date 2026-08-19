# ============================================================
# CELL 3 — H2H SUMMARY / STATISTICS
# ============================================================

# ============================================================
# DATA VALIDATION
# ============================================================

if "h2h" not in globals() or h2h.empty:
    print("❌ No H2H dataset available. Run Cell 2 first.")

else:

    # ========================================================
    # TEAM 1
    # ========================================================

    TEAM1_ID = TEAM_ID

    team1_rows = h2h[
        (h2h["home_team_id"] == TEAM1_ID) |
        (h2h["away_team_id"] == TEAM1_ID)
    ]

    if team1_rows.empty:
        print("❌ Could not identify Team 1.")

    else:

        first = team1_rows.iloc[0]

        TEAM1_NAME = (
            first["home_team"]
            if first["home_team_id"] == TEAM1_ID
            else first["away_team"]
        )

        # ====================================================
        # ORIENT ALL MATCHES
        # ====================================================

        records = []

        for _, row in h2h.iterrows():

            if row["home_team_id"] == TEAM1_ID:
                t1_score = row["home_score"]
                t2_score = row["away_score"]
                t1_sets = row["home_set_scores"]
                t2_sets = row["away_set_scores"]
                t1_kills = row["home_kills"]
                t2_kills = row["away_kills"]
                t1_blocks = row["home_block_points"]
                t2_blocks = row["away_block_points"]
                t1_aces = row["home_aces"]
                t2_aces = row["away_aces"]
                t1_errors = row["home_opponent_errors"]
                t2_errors = row["away_opponent_errors"]
                opponent = row["away_team"]

            else:
                t1_score = row["away_score"]
                t2_score = row["home_score"]
                t1_sets = row["away_set_scores"]
                t2_sets = row["home_set_scores"]
                t1_kills = row["away_kills"]
                t2_kills = row["home_kills"]
                t1_blocks = row["away_block_points"]
                t2_blocks = row["home_block_points"]
                t1_aces = row["away_aces"]
                t2_aces = row["home_aces"]
                t1_errors = row["away_opponent_errors"]
                t2_errors = row["home_opponent_errors"]
                opponent = row["home_team"]

            if t1_score > t2_score:
                result = "WIN"
            elif t1_score < t2_score:
                result = "LOSS"
            else:
                result = "DRAW"

            records.append({
                "match_id": row["match_id"],
                "date": row["scheduledDate"],
                "opponent": opponent,
                "competition": row.get("competition", "UNKNOWN"),
                "team1_score": t1_score,
                "team2_score": t2_score,
                "team1_sets": t1_sets,
                "team2_sets": t2_sets,
                "sets_played": t1_score + t2_score,
                "team1_kills": t1_kills,
                "team2_kills": t2_kills,
                "team1_blocks": t1_blocks,
                "team2_blocks": t2_blocks,
                "team1_aces": t1_aces,
                "team2_aces": t2_aces,
                "team1_errors": t1_errors,
                "team2_errors": t2_errors,
                "result": result
            })

        h2h_summary = pd.DataFrame(records)

        # ====================================================
        # BASIC SUMMARY
        # ====================================================

        matches = len(h2h_summary)

        wins = (h2h_summary["result"] == "WIN").sum()
        losses = (h2h_summary["result"] == "LOSS").sum()
        draws = (h2h_summary["result"] == "DRAW").sum()

        win_rate = wins / matches * 100 if matches else 0

        avg_sets = h2h_summary["team1_score"].mean()

        # Actual opponent name(s)
        opponents = [
            str(x) for x in h2h_summary["opponent"].dropna().unique()
        ]

        OPPONENT_NAME = ", ".join(opponents)

        # ====================================================
        # AVERAGE STATISTICS
        # ====================================================

        avg_kills_1 = h2h_summary["team1_kills"].mean()
        avg_kills_2 = h2h_summary["team2_kills"].mean()

        avg_blocks_1 = h2h_summary["team1_blocks"].mean()
        avg_blocks_2 = h2h_summary["team2_blocks"].mean()

        avg_aces_1 = h2h_summary["team1_aces"].mean()
        avg_aces_2 = h2h_summary["team2_aces"].mean()

        avg_errors_1 = h2h_summary["team1_errors"].mean()
        avg_errors_2 = h2h_summary["team2_errors"].mean()

        # ====================================================
        # TOTALS
        # ====================================================

        total_kills_1 = h2h_summary["team1_kills"].sum()
        total_kills_2 = h2h_summary["team2_kills"].sum()

        total_blocks_1 = h2h_summary["team1_blocks"].sum()
        total_blocks_2 = h2h_summary["team2_blocks"].sum()

        total_aces_1 = h2h_summary["team1_aces"].sum()
        total_aces_2 = h2h_summary["team2_aces"].sum()
        # Total sets won
        total_sets_won_1 = h2h_summary["team1_score"].sum()
        total_sets_won_2 = h2h_summary["team2_score"].sum()
        
        # ====================================================
        # TOTAL RALLY POINTS
        # ====================================================

        def calculate_points(row):

            home_points = sum(row["home_set_scores"])
            away_points = sum(row["away_set_scores"])

            if row["home_team_id"] == TEAM1_ID:

                return pd.Series({
                    "team1_points": home_points,
                    "team2_points": away_points
                })

            return pd.Series({
                "team1_points": away_points,
                "team2_points": home_points
            })


        point_totals = h2h.apply(
            calculate_points,
            axis=1
        )

        h2h_summary[
            ["team1_points", "team2_points"]
        ] = point_totals

        h2h_summary["total_match_points"] = (
            h2h_summary["team1_points"]
            + h2h_summary["team2_points"]
        )

        avg_points_1 = h2h_summary["team1_points"].mean()
        avg_points_2 = h2h_summary["team2_points"].mean()

        avg_total_points = (
            h2h_summary["total_match_points"].mean()
        )

        total_points_1 = h2h_summary["team1_points"].sum()
        total_points_2 = h2h_summary["team2_points"].sum()
        # ====================================================
        # COMPETITION BREAKDOWN
        # ====================================================

        competition_rows = []

        for competition, group in h2h_summary.groupby(
            "competition", dropna=False
        ):

            n = len(group)
            w = (group["result"] == "WIN").sum()
            l = (group["result"] == "LOSS").sum()

            competition_rows.append({
                "competition": (
                    competition
                    if pd.notna(competition)
                    else "UNKNOWN"
                ),
                "matches": n,
                "wins": w,
                "losses": l,
                "win_rate": w / n * 100 if n else 0
            })

        competition_df = pd.DataFrame(
            competition_rows
        ).sort_values(
            "matches",
            ascending=False
        )

        # ====================================================
        # CSS
        # ====================================================

        css = """
        <style>

        .h2h-dashboard {
            width: 94%;
            max-width: 1100px;
            margin: 20px auto;
            font-family: Arial, sans-serif;
            color: #202744;
            box-sizing: border-box;
        }

        .h2h-title {
            text-align: center;
            color: #202744;
            font-size: 28px;
            font-weight: 700;
            margin: 0 0 6px 0;
        }

        .h2h-subtitle {
            text-align: center;
            color: #6874a8;
            font-size: 15px;
            margin-bottom: 22px;
        }

        .h2h-result {
            width: 100%;
            box-sizing: border-box;
            display: grid;
            grid-template-columns: 1fr 180px 1fr;
            align-items: center;
            text-align: center;
            background: #151c52;
            border-radius: 16px;
            padding: 25px 30px;
            margin: 0 auto 18px auto;
        }

        .h2h-team {
            color: #ffffff;
            font-size: 22px;
            font-weight: 700;
        }

        .h2h-record {
            color: #ffffff;
            font-size: 31px;
            font-weight: 700;
            line-height: 1;
        }

        .h2h-record-label {
            color: #aeb7e8;
            font-size: 12px;
            margin-top: 8px;
        }

        .h2h-cards {
            width: 100%;
            display: grid;
            grid-template-columns: repeat(4, 1fr);
            gap: 12px;
            margin-bottom: 22px;
        }

        .h2h-card {
            background: #151c52;
            border-radius: 12px;
            padding: 18px 10px;
            text-align: center;
        }

        .h2h-card-value {
            color: #ffffff;
            font-size: 27px;
            font-weight: 700;
        }

        .h2h-card-label {
            color: #aeb7e8;
            font-size: 13px;
            margin-top: 6px;
        }

        .h2h-section {
            width: 100%;
            box-sizing: border-box;
            background: #11173f;
            border-radius: 14px;
            padding: 20px;
            margin-bottom: 20px;
        }

        .h2h-section-title {
            color: #ffffff;
            text-align: center;
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 12px;
        }

        .stat-row {
            display: grid;
            grid-template-columns: 1fr 140px 1fr;
            align-items: center;
            text-align: center;
            padding: 13px 5px;
            border-bottom: 1px solid #303879;
        }

        .stat-row:last-child {
            border-bottom: none;
        }

        .stat-name {
            color: #ffffff;
            font-weight: 600;
        }

        .stat-value {
            color: #ffffff;
            font-size: 18px;
            font-weight: 700;
        }
        
        .competition-table {
        
            width: 100%;
        
            border-collapse: collapse;
        
            color: #ffffff;
        
            table-layout: fixed;
        
        }
        
        
        
        .competition-table th,
        
        .competition-table td {
        
            padding: 11px;
        
            border-bottom: 1px solid #303879;
        
            text-align: center;
        
            vertical-align: middle;
        
        }
        
        
        
        .competition-table th:nth-child(1),
        
        .competition-table td:nth-child(1),
        
        .competition-table th:nth-child(2),
        
        .competition-table td:nth-child(2),
        
        .competition-table th:nth-child(3),
        
        .competition-table td:nth-child(3),
        
        .competition-table th:nth-child(4),
        
        .competition-table td:nth-child(4),
        
        .competition-table th:nth-child(5),
        
        .competition-table td:nth-child(5) {
        
            text-align: center;
        
        }
        
        
        
        .competition-table th {
        
            color: #aeb7e8;
        
            font-size: 13px;
        
            font-weight: 700;
        
        }

        @media(max-width:700px) {
            .h2h-result {
                grid-template-columns: 1fr;
                gap: 12px;
            }

            .h2h-cards {
                grid-template-columns: repeat(2, 1fr);
            }

            .stat-row {
                grid-template-columns: 1fr 100px 1fr;
            }
        }

        </style>
        """

        # ====================================================
        # STAT ROW
        # ====================================================

        def stat_row(name, value1, value2, decimals=1):
            return f"""
            <div class="stat-row">
                <div class="stat-value">{value1:.{decimals}f}</div>
                <div class="stat-name">{name}</div>
                <div class="stat-value">{value2:.{decimals}f}</div>
            </div>
            """

        # ====================================================
        # BUILD DASHBOARD
        # ====================================================

        html = css + f"""
        <div class="h2h-dashboard">

            <div class="h2h-title">
                H2H Statistics
            </div>

            <div class="h2h-subtitle">
                {TEAM1_NAME} vs {OPPONENT_NAME}
                • {matches} matches
            </div>

            <!-- H2H RECORD -->

            <div class="h2h-result">

                <div class="h2h-team">
                    {TEAM1_NAME}
                </div>

                <div>
                    <div class="h2h-record">
                        {wins} - {losses}
                    </div>
                    <div class="h2h-record-label">
                        H2H RECORD
                    </div>
                </div>

                <div class="h2h-team">
                    {OPPONENT_NAME}
                </div>

            </div>

            <!-- SUMMARY CARDS -->

            <div class="h2h-cards">

                <div class="h2h-card">
                    <div class="h2h-card-value">{matches}</div>
                    <div class="h2h-card-label">MATCHES</div>
                </div>

                <div class="h2h-card">
                    <div class="h2h-card-value">{win_rate:.1f}%</div>
                    <div class="h2h-card-label">WIN RATE</div>
                </div>

                <div class="h2h-card">
                    <div class="h2h-card-value">{avg_sets:.1f}</div>
                    <div class="h2h-card-label">AVG SETS / MATCH</div>
                </div>

                <div class="h2h-card">
                    <div class="h2h-card-value">{avg_total_points:.1f}</div>
                    <div class="h2h-card-label">AVG TOTAL POINTS / MATCH</div>
                </div>

            </div>

            <!-- AVERAGE MATCH STATISTICS -->

            <div class="h2h-section">

                <div class="h2h-section-title">
                    Average Match Statistics
                </div>

                {stat_row("ATTACK", avg_kills_1, avg_kills_2)}
                {stat_row("BLOCK", avg_blocks_1, avg_blocks_2)}
                {stat_row("SERVE", avg_aces_1, avg_aces_2)}
                {stat_row("OPPONENT ERROR", avg_errors_1, avg_errors_2)}
                {stat_row("POINTS", avg_points_1, avg_points_2)}

            </div>

            <!-- H2H TOTALS -->

            <div class="h2h-section">

                <div class="h2h-section-title">
                    H2H Totals
                </div>
                {stat_row("SETS WON", total_sets_won_1, total_sets_won_2, 0)}
                {stat_row("ATTACK", total_kills_1, total_kills_2, 0)}
                {stat_row("BLOCK", total_blocks_1, total_blocks_2, 0)}
                {stat_row("SERVE", total_aces_1, total_aces_2, 0)}
                {stat_row("OPPONENT ERROR",h2h_summary["team1_errors"].sum(),h2h_summary["team2_errors"].sum(), 0)}
                {stat_row("POINTS", total_points_1, total_points_2, 0)}

            </div>

            <!-- COMPETITION BREAKDOWN -->

            <div class="h2h-section">

                <div class="h2h-section-title">
                    Competition Breakdown
                </div>

                <table class="competition-table">

                    <thead>
                        <tr>
                            <th>Competition</th>
                            <th>Matches</th>
                            <th>Wins</th>
                            <th>Losses</th>
                            <th>Win Rate</th>
                        </tr>
                    </thead>

                    <tbody>
        """

        # ====================================================
        # COMPETITION ROWS
        # ====================================================

        for _, row in competition_df.iterrows():

            html += f"""
                        <tr>
                            <td>{row["competition"]}</td>
                            <td>{row["matches"]}</td>
                            <td>{row["wins"]}</td>
                            <td>{row["losses"]}</td>
                            <td>{row["win_rate"]:.1f}%</td>
                        </tr>
            """

        html += """
                    </tbody>

                </table>

            </div>

        </div>
        """

        # ====================================================
        # DISPLAY
        # ====================================================

        display(HTML(html))

        # ====================================================
        # MATCH RECORD
        # ====================================================

        print("\nH2H Match Record")

        display(
            h2h_summary[
                [
                    "date",
                    "opponent",
                    "competition",
                    "team1_score",
                    "team2_score",
                    "result"
                ]
            ]
            .sort_values("date", ascending=False)
            .reset_index(drop=True)
        )
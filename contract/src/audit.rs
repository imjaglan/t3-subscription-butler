//! Pure audit engine — no host imports, fully unit-testable on the host.
//!
//! Rules, applied to ACTIVE subscriptions only:
//!   1. dead_weight  — usage below `DEAD_WEIGHT_THRESHOLD` → recommend cancel.
//!   2. duplicate    — several active subs share a category → keep the best
//!                     (highest usage, ties broken by lower price, then id),
//!                     recommend cancelling the rest.
//!   3. over_budget  — when a USD budget is given and the active USD monthly
//!                     total (after cancel savings) still exceeds it, flag the
//!                     lowest-value remaining subs for review until the
//!                     projected total fits.
//!
//! A subscription flagged by several rules yields ONE recommendation with all
//! rule tags merged; `cancel` wins over `review`. Output ordering is
//! deterministic: largest monthly saving first, then id.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::types::Subscription;

/// Usage score below which an active subscription is considered dead weight.
pub const DEAD_WEIGHT_THRESHOLD: f64 = 0.2;

/// Upper sanity bound for a single subscription price (1,000,000.00 in minor
/// units) — anything above is a corrupt upstream record, not a price.
const MAX_AMOUNT_CENTS: i64 = 100_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Cancel,
    Review,
}

#[derive(Debug, Serialize)]
pub struct Recommendation {
    pub subscription_id: String,
    pub name: String,
    pub category: String,
    pub action: Action,
    /// Rule tags that fired: "dead_weight" | "duplicate" | "over_budget".
    pub rules: Vec<String>,
    pub reason: String,
    pub monthly_cost_cents: u64,
    /// Equal to monthly cost for `cancel`, 0 for `review` (a review is a
    /// prompt for the user, not a committed saving).
    pub monthly_saving_cents: u64,
    pub currency: String,
}

#[derive(Debug, Serialize)]
pub struct BudgetSummary {
    pub monthly_budget_cents: u64,
    pub usd_monthly_total_cents: u64,
    /// 0 when within budget.
    pub over_budget_cents: u64,
    /// USD total after applying every `cancel` recommendation.
    pub projected_after_cancels_cents: u64,
}

#[derive(Debug, Serialize)]
pub struct AuditReport {
    pub active_count: usize,
    pub cancelled_count: usize,
    /// Active monthly run-rate per currency, e.g. { "USD": 7295 }.
    pub monthly_total_cents: BTreeMap<String, u64>,
    pub recommendations: Vec<Recommendation>,
    /// Sum of `cancel` savings per currency.
    pub potential_monthly_saving_cents: BTreeMap<String, u64>,
    /// Present only when a budget was supplied. Budgets are USD-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget: Option<BudgetSummary>,
}

/// Normalise a price to monthly cents. Yearly prices are rounded to the
/// nearest cent (`+6` before integer division by 12).
fn monthly_cents(sub: &Subscription) -> Result<u64, String> {
    if sub.amount_cents < 0 || sub.amount_cents > MAX_AMOUNT_CENTS {
        return Err(format!(
            "bad-input: subscription {} has out-of-range amountCents {}",
            sub.id, sub.amount_cents
        ));
    }
    let amount = sub.amount_cents as u64;
    match sub.cadence.as_str() {
        "monthly" => Ok(amount),
        "yearly" => Ok((amount + 6) / 12),
        other => Err(format!(
            "bad-input: subscription {} has unknown cadence \"{other}\"",
            sub.id
        )),
    }
}

/// Clamp a possibly out-of-range usage score into [0, 1]. NaN counts as 0
/// (no usage signal at all should read as "unused", never as "well used").
fn clamped_usage(score: f64) -> f64 {
    if score.is_nan() {
        0.0
    } else {
        score.clamp(0.0, 1.0)
    }
}

struct WorkingRec {
    action: Action,
    rules: Vec<String>,
    reasons: Vec<String>,
}

pub fn compute_audit(
    subs: &[Subscription],
    monthly_budget_cents: Option<u64>,
) -> Result<AuditReport, String> {
    // Validate every record up front so a half-processed report can't leak out.
    let mut active: Vec<(&Subscription, u64, f64)> = Vec::new(); // (sub, monthly, usage)
    let mut cancelled_count = 0usize;
    for sub in subs {
        let monthly = monthly_cents(sub)?;
        match sub.status.as_str() {
            "active" => active.push((sub, monthly, clamped_usage(sub.usage_score))),
            "cancelled" => cancelled_count += 1,
            other => {
                return Err(format!(
                    "bad-input: subscription {} has unknown status \"{other}\"",
                    sub.id
                ))
            }
        }
    }

    let mut monthly_total: BTreeMap<String, u64> = BTreeMap::new();
    for (sub, monthly, _) in &active {
        *monthly_total.entry(sub.currency.clone()).or_insert(0) += monthly;
    }

    // Keyed by subscription id; BTreeMap keeps iteration deterministic.
    let mut recs: BTreeMap<String, WorkingRec> = BTreeMap::new();
    fn add(
        recs: &mut BTreeMap<String, WorkingRec>,
        sub: &Subscription,
        action: Action,
        rule: &str,
        reason: String,
    ) {
        let entry = recs.entry(sub.id.clone()).or_insert_with(|| WorkingRec {
            action,
            rules: Vec::new(),
            reasons: Vec::new(),
        });
        if action == Action::Cancel {
            entry.action = Action::Cancel; // cancel dominates review
        }
        if !entry.rules.iter().any(|r| r == rule) {
            entry.rules.push(rule.to_string());
            entry.reasons.push(reason);
        }
    }

    // Rule 1 — dead weight.
    for (sub, _, usage) in &active {
        if *usage < DEAD_WEIGHT_THRESHOLD {
            add(
                &mut recs,
                sub,
                Action::Cancel,
                "dead_weight",
                format!(
                    "usage score {usage:.2} is below the {DEAD_WEIGHT_THRESHOLD:.2} dead-weight threshold"
                ),
            );
        }
    }

    // Rule 2 — duplicate categories: keep the best, cancel the rest.
    let mut by_category: BTreeMap<&str, Vec<&(&Subscription, u64, f64)>> = BTreeMap::new();
    for entry in &active {
        by_category.entry(entry.0.category.as_str()).or_default().push(entry);
    }
    for (category, mut entries) in by_category {
        if entries.len() < 2 {
            continue;
        }
        // Best = highest usage, then cheaper, then id (total order → deterministic).
        entries.sort_by(|a, b| {
            b.2.partial_cmp(&a.2)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(a.1.cmp(&b.1))
                .then(a.0.id.cmp(&b.0.id))
        });
        let keep = entries[0].0;
        for (sub, _, usage) in entries.iter().skip(1) {
            add(
                &mut recs,
                sub,
                Action::Cancel,
                "duplicate",
                format!(
                    "duplicates category \"{category}\" — \"{}\" covers it with higher usage ({:.2} vs {usage:.2})",
                    keep.name,
                    clamped_usage(keep.usage_score),
                ),
            );
        }
    }

    // Savings from cancels so far (per currency), needed for the budget rule.
    let saving_of = |id: &str, recs: &BTreeMap<String, WorkingRec>| -> bool {
        recs.get(id).map(|r| r.action == Action::Cancel).unwrap_or(false)
    };
    let usd_cancel_savings: u64 = active
        .iter()
        .filter(|(sub, _, _)| sub.currency == "USD" && saving_of(&sub.id, &recs))
        .map(|(_, monthly, _)| *monthly)
        .sum();

    // Rule 3 — over budget (USD only; the mock billing API is USD-only and a
    // cross-currency budget would silently mix units).
    let mut budget_summary = None;
    if let Some(budget) = monthly_budget_cents {
        let usd_total = monthly_total.get("USD").copied().unwrap_or(0);
        let mut projected = usd_total.saturating_sub(usd_cancel_savings);
        if projected > budget {
            // Flag lowest value-per-dollar first; never flag something already
            // recommended for cancellation (its saving is already counted).
            let mut candidates: Vec<&(&Subscription, u64, f64)> = active
                .iter()
                .filter(|(sub, monthly, _)| {
                    sub.currency == "USD" && *monthly > 0 && !saving_of(&sub.id, &recs)
                })
                .collect();
            candidates.sort_by(|a, b| {
                let density_a = a.2 / a.1 as f64;
                let density_b = b.2 / b.1 as f64;
                density_a
                    .partial_cmp(&density_b)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.0.id.cmp(&b.0.id))
            });
            for (sub, monthly, usage) in candidates {
                if projected <= budget {
                    break;
                }
                add(
                    &mut recs,
                    sub,
                    Action::Review,
                    "over_budget",
                    format!(
                        "active total exceeds budget — lowest value per dollar (usage {usage:.2} at {monthly} cents/mo)"
                    ),
                );
                projected = projected.saturating_sub(*monthly);
            }
        }
        budget_summary = Some(BudgetSummary {
            monthly_budget_cents: budget,
            usd_monthly_total_cents: usd_total,
            over_budget_cents: usd_total.saturating_sub(budget),
            projected_after_cancels_cents: usd_total.saturating_sub(usd_cancel_savings),
        });
    }

    // Materialise recommendations.
    let mut recommendations: Vec<Recommendation> = Vec::new();
    for (sub, monthly, _) in &active {
        if let Some(work) = recs.get(&sub.id) {
            recommendations.push(Recommendation {
                subscription_id: sub.id.clone(),
                name: sub.name.clone(),
                category: sub.category.clone(),
                action: work.action,
                rules: work.rules.clone(),
                reason: work.reasons.join("; "),
                monthly_cost_cents: *monthly,
                monthly_saving_cents: if work.action == Action::Cancel { *monthly } else { 0 },
                currency: sub.currency.clone(),
            });
        }
    }
    recommendations.sort_by(|a, b| {
        b.monthly_saving_cents
            .cmp(&a.monthly_saving_cents)
            .then(a.subscription_id.cmp(&b.subscription_id))
    });

    let mut potential: BTreeMap<String, u64> = BTreeMap::new();
    for rec in &recommendations {
        if rec.action == Action::Cancel {
            *potential.entry(rec.currency.clone()).or_insert(0) += rec.monthly_saving_cents;
        }
    }

    Ok(AuditReport {
        active_count: active.len(),
        cancelled_count,
        monthly_total_cents: monthly_total,
        recommendations,
        potential_monthly_saving_cents: potential,
        budget: budget_summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sub(id: &str, category: &str, cents: i64, usage: f64) -> Subscription {
        Subscription {
            id: id.to_string(),
            name: id.to_string(),
            category: category.to_string(),
            amount_cents: cents,
            currency: "USD".to_string(),
            cadence: "monthly".to_string(),
            status: "active".to_string(),
            last_charged_at: None,
            usage_score: usage,
        }
    }

    #[test]
    fn empty_list_yields_empty_report() {
        let report = compute_audit(&[], None).expect("ok");
        assert_eq!(report.active_count, 0);
        assert!(report.recommendations.is_empty());
        assert!(report.monthly_total_cents.is_empty());
    }

    #[test]
    fn dead_weight_is_flagged_for_cancel() {
        let subs = vec![sub("sub_gym", "fitness", 1299, 0.04), sub("sub_tv", "streaming", 2299, 0.82)];
        let report = compute_audit(&subs, None).expect("ok");
        assert_eq!(report.recommendations.len(), 1);
        let rec = &report.recommendations[0];
        assert_eq!(rec.subscription_id, "sub_gym");
        assert_eq!(rec.action, Action::Cancel);
        assert_eq!(rec.rules, vec!["dead_weight"]);
        assert_eq!(rec.monthly_saving_cents, 1299);
        assert_eq!(report.potential_monthly_saving_cents["USD"], 1299);
    }

    #[test]
    fn duplicate_keeps_highest_usage_and_cancels_rest() {
        let subs = vec![
            sub("sub_cloud_a", "cloud-storage", 1199, 0.21),
            sub("sub_cloud_b", "cloud-storage", 999, 0.68),
        ];
        let report = compute_audit(&subs, None).expect("ok");
        assert_eq!(report.recommendations.len(), 1);
        assert_eq!(report.recommendations[0].subscription_id, "sub_cloud_a");
        assert!(report.recommendations[0].rules.contains(&"duplicate".to_string()));
    }

    #[test]
    fn duplicate_tie_breaks_on_price_then_id() {
        let subs = vec![
            sub("sub_b", "news", 900, 0.5),
            sub("sub_a", "news", 700, 0.5),
        ];
        let report = compute_audit(&subs, None).expect("ok");
        // Same usage → keep the cheaper one (sub_a), cancel sub_b.
        assert_eq!(report.recommendations[0].subscription_id, "sub_b");
    }

    #[test]
    fn dead_weight_and_duplicate_merge_into_one_recommendation() {
        let subs = vec![
            sub("sub_low", "cloud-storage", 1199, 0.04), // dead weight AND worse duplicate
            sub("sub_high", "cloud-storage", 999, 0.68),
        ];
        let report = compute_audit(&subs, None).expect("ok");
        assert_eq!(report.recommendations.len(), 1);
        let rec = &report.recommendations[0];
        assert_eq!(rec.action, Action::Cancel);
        assert_eq!(rec.rules.len(), 2);
        // Saving counted once, not per rule.
        assert_eq!(report.potential_monthly_saving_cents["USD"], 1199);
    }

    #[test]
    fn over_budget_flags_lowest_value_until_projection_fits() {
        let subs = vec![
            sub("sub_keep", "music", 1000, 0.9),
            sub("sub_meh", "news", 2000, 0.3),
            sub("sub_ok", "streaming", 1500, 0.7),
        ];
        // Total 4500, budget 2600 → must shed ~1900 → sub_meh (lowest density) flagged.
        let report = compute_audit(&subs, Some(2600)).expect("ok");
        let flagged: Vec<_> = report
            .recommendations
            .iter()
            .filter(|r| r.rules.contains(&"over_budget".to_string()))
            .collect();
        assert_eq!(flagged.len(), 1);
        assert_eq!(flagged[0].subscription_id, "sub_meh");
        assert_eq!(flagged[0].action, Action::Review);
        assert_eq!(flagged[0].monthly_saving_cents, 0);
        let budget = report.budget.expect("budget summary present");
        assert_eq!(budget.usd_monthly_total_cents, 4500);
        assert_eq!(budget.over_budget_cents, 1900);
    }

    #[test]
    fn budget_counts_cancel_savings_before_flagging() {
        let subs = vec![
            sub("sub_dead", "fitness", 3000, 0.01), // cancelled by dead_weight
            sub("sub_fine", "music", 1000, 0.9),
        ];
        // Total 4000; cancelling sub_dead projects 1000 ≤ budget 1500 → no review flags.
        let report = compute_audit(&subs, Some(1500)).expect("ok");
        assert!(report
            .recommendations
            .iter()
            .all(|r| !r.rules.contains(&"over_budget".to_string())));
        assert_eq!(report.budget.unwrap().projected_after_cancels_cents, 1000);
    }

    #[test]
    fn yearly_cadence_normalises_to_monthly_rounded() {
        let mut s = sub("sub_year", "tools", 11999, 0.9); // 119.99/yr
        s.cadence = "yearly".to_string();
        let report = compute_audit(&[s], None).expect("ok");
        assert_eq!(report.monthly_total_cents["USD"], 1000); // 999.92 → 1000
    }

    #[test]
    fn cancelled_subs_are_counted_but_never_recommended() {
        let mut s = sub("sub_old", "news", 799, 0.0);
        s.status = "cancelled".to_string();
        let report = compute_audit(&[s], None).expect("ok");
        assert_eq!(report.cancelled_count, 1);
        assert_eq!(report.active_count, 0);
        assert!(report.recommendations.is_empty());
    }

    #[test]
    fn negative_amount_is_rejected() {
        let s = sub("sub_bad", "news", -1, 0.5);
        assert!(compute_audit(&[s], None).unwrap_err().contains("out-of-range"));
    }

    #[test]
    fn unknown_cadence_is_rejected() {
        let mut s = sub("sub_bad", "news", 100, 0.5);
        s.cadence = "weekly".to_string();
        assert!(compute_audit(&[s], None).unwrap_err().contains("unknown cadence"));
    }

    #[test]
    fn unknown_status_is_rejected() {
        let mut s = sub("sub_bad", "news", 100, 0.5);
        s.status = "paused".to_string();
        assert!(compute_audit(&[s], None).unwrap_err().contains("unknown status"));
    }

    #[test]
    fn nan_and_out_of_range_usage_clamp_safely() {
        let mut s1 = sub("sub_nan", "a", 100, f64::NAN); // NaN → 0 → dead weight
        s1.category = "a".to_string();
        let s2 = sub("sub_big", "b", 100, 7.5); // clamps to 1.0 → fine
        let report = compute_audit(&[s1, s2], None).expect("ok");
        assert_eq!(report.recommendations.len(), 1);
        assert_eq!(report.recommendations[0].subscription_id, "sub_nan");
    }

    #[test]
    fn mixed_currencies_total_separately_and_budget_stays_usd() {
        let mut eur = sub("sub_eur", "music", 1000, 0.9);
        eur.currency = "EUR".to_string();
        let usd = sub("sub_usd", "news", 2000, 0.9);
        let report = compute_audit(&[eur, usd], Some(5000)).expect("ok");
        assert_eq!(report.monthly_total_cents["EUR"], 1000);
        assert_eq!(report.monthly_total_cents["USD"], 2000);
        assert_eq!(report.budget.unwrap().usd_monthly_total_cents, 2000);
    }

    #[test]
    fn output_ordering_is_deterministic_by_saving_then_id() {
        let subs = vec![
            sub("sub_a", "x", 500, 0.01),
            sub("sub_b", "y", 1500, 0.01),
            sub("sub_c", "z", 500, 0.01),
        ];
        let report = compute_audit(&subs, None).expect("ok");
        let ids: Vec<_> = report.recommendations.iter().map(|r| r.subscription_id.as_str()).collect();
        assert_eq!(ids, vec!["sub_b", "sub_a", "sub_c"]);
    }
}

use super::*;

#[test]
fn abandoned_reservations_refund_budget_without_relaxing_concurrency_or_total() {
    let family = Arc::new(DelegationFamily::new("user"));
    for _ in 0..12 {
        let first = family.reserve().unwrap();
        let second = family.reserve().unwrap();
        assert!(family.reserve().is_err(), "Only two slots may be held");
        drop(first);
        drop(second);
    }
    for _ in 0..8 {
        let mut reservation = family.reserve().unwrap();
        reservation.admitted = true;
    }
    assert!(
        family.reserve().is_err(),
        "Eight admitted children exhaust the budget"
    );
    assert_eq!(family.slots.available_permits(), 2);
}

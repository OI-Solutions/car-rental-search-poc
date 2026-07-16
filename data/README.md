# Synthetic B2B Car-Rental Dataset

This directory contains a small, deterministic dataset for an OpenSearch proof of concept involving centralized inventory search and customer-specific pricing.

## Files

- `dealerships.json`: five Illinois dealership branches.
- `vehicle_models.json`: five vehicle models/classes.
- `inventory.json`: 50 dealership inventory records.
- `customers.json`: 12 synthetic business customers.
- `agreements.json`: customer/dealership discount agreements.
- `users.json`: mock users for customer, dealership, and corporate roles.

## Relationship model

- `inventory.dealership_id` → `dealerships.dealership_id`
- `inventory.vehicle_model_id` → `vehicle_models.vehicle_model_id`
- `agreements.customer_id` → `customers.customer_id`
- `agreements.dealership_id` → `dealerships.dealership_id`
- `users.customer_id` → `customers.customer_id` for `customer_user`
- `users.dealership_id` → `dealerships.dealership_id` for `dealership_user`

## Access assumptions

- Customers may access only their own personalized pricing.
- Dealership users may access only their dealership’s inventory, customers, and agreements.
- Corporate administrators may access the full centralized dataset.
- Authentication is mocked; no real passwords or password hashes are included.

## Pricing behavior intentionally represented

The dataset includes customers with different negotiated discounts at different dealerships, customers with no agreement at some dealerships, and at least one case where the dealership with the lowest public base price does not produce the lowest personalized price.

Example:

- Joliet has an SUV base daily rate of `$84`.
- Chicago has an SUV base daily rate of `$92`.
- Customer `CUS-001` receives a 28% general discount at Chicago.
- Personalized Chicago SUV price: `$66.24`.
- Therefore Chicago becomes cheaper for that customer despite the higher base rate.

## Validation

From the project root:

```bash
python3 scripts/validate_data.py
```

The validator checks:

- unique IDs
- valid foreign-key references
- agreement counts of 2–4 dealerships per customer
- valid discount ranges
- role-specific user references
- the intended personalized-price inversion

## Regeneration

The checked-in files are canonical and deterministic. To rewrite them in stable JSON formatting:

```bash
python3 scripts/generate_data.py
```

The fixed random seed is `42`.

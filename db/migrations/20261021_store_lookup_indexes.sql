CREATE INDEX IF NOT EXISTS idx_store_orders_lead_click ON public.store_orders(lead_click_id) WHERE lead_click_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_store_connections_account ON public.store_connections(account_id) WHERE account_id IS NOT NULL;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('merchant-images', 'merchant-images', false, 4000000, ARRAY['image/jpeg','image/png'])
ON CONFLICT (id) DO UPDATE SET public=false, file_size_limit=4000000, allowed_mime_types=ARRAY['image/jpeg','image/png'];
-- No browser policies: authenticated upload route and execution use service_role only.
-- A restrictive policy also defeats any pre-existing broad permissive policy.
DROP POLICY IF EXISTS merchant_images_server_only ON storage.objects;
CREATE POLICY merchant_images_server_only ON storage.objects AS RESTRICTIVE FOR ALL TO anon, authenticated
 USING (bucket_id <> 'merchant-images') WITH CHECK (bucket_id <> 'merchant-images');

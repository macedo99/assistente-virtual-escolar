-- No "Marcar como indexado" do workflow "RAG - Reindexar item" do n8n
UPDATE itens_base_conhecimento
   SET status_indexacao = 'indexado', atualizado_em = now()
 WHERE id = $1
   AND (SELECT count(*) FROM trechos_embeddings WHERE item_id = $1) = $2;

-- No "Salvar trecho" do workflow "RAG - Reindexar item" do n8n
INSERT INTO trechos_embeddings (item_id, conteudo_trecho, embedding)
VALUES ($1, $2, $3);

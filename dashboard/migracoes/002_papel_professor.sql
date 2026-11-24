-- Passo 9 (segurança): todo usuário novo do bot entra como "professor".
--
-- Antes, o n8n decidia o papel procurando a palavra "gestor" no texto que o próprio usuário digitou
-- (até "não sou gestor" virava gestor). Agora o papel de gestor só é dado por um administrador, na tela
-- "Usuários" do dashboard.
--
-- Este gatilho garante a regra no próprio banco, mesmo que o nó "Inserir usuário" do n8n ainda não tenha
-- sido atualizado: qualquer INSERT em usuarios grava papel = 'professor'. Mudanças de papel feitas depois
-- (UPDATE, pela tela do dashboard) não passam por aqui.
--
-- Usuários que JÁ existem não são alterados: revise os gestores atuais na tela "Usuários".

CREATE OR REPLACE FUNCTION usuarios_novos_sao_professores() RETURNS trigger AS $$
BEGIN
    NEW.papel := 'professor';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_usuarios_papel_inicial ON usuarios;
CREATE TRIGGER trg_usuarios_papel_inicial
    BEFORE INSERT ON usuarios
    FOR EACH ROW EXECUTE FUNCTION usuarios_novos_sao_professores();

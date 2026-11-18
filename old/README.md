# Kart Rush — biblioteca visual v1

Esta pasta contém referências PNG extraídas da prancha de design do Kart Rush.

- São 44 referências organizadas nos grupos A–G.
- Todos os objetos 3D estão isolados em fundo branco e nomeados para corresponder ao `.glb` de saída.
- `kart_body.png` reutiliza o render dedicado de alta resolução gerado anteriormente.
- **Limitação importante:** os demais objetos foram recortados e ampliados de uma prancha ilustrada. A resolução original de cada asset é pequena. São referências de conceito, **não** imagens finais de alta resolução para Tripo; para maximizar a qualidade 3D, gere um render dedicado por objeto usando o prompt original.
- Texturas foram ajustadas para coincidir nas bordas por espelhamento; revise visualmente repetições, materiais e escala antes de usar no jogo.
- Limites de faces indicados no `manifest.csv` são metas do planejamento, não contagens de malhas 3D existentes.
- Objetos repetidos devem ter pivô na base, escala em metros e poucos materiais para facilitar instanciamento.
- As letras A–G representam os grupos do documento fornecido pelo usuário.

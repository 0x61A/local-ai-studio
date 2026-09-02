#!/usr/bin/env python3
"""PyTorch GPT-2 mimarili bir kontrol noktasini GGUF'a cevirir.

BU BIR GELISTIRME ARACIDIR, CALISMA ZAMANI BAGIMLILIGI DEGIL.
Uygulamanin kendisi saf Node.js; bu betik yalnizca bir kez, model sahibi
tarafindan calistirilir. Cikan .gguf dosyasi data/models/ altina konur ve
diger butun modeller gibi llama.cpp ile yuklenir.

Neden cevirmek: modeli TypeScript'te yeniden yazmak yerine mevcut motora
baglamak, bu modele de akis, arac cagirma, butce yoneticisi, ajan ve RAG'in
tamamini bedava kazandirir.

Beklenen kaynak (uyum-v3 ile ayni sekil):
  tok_emb.weight, pos_emb.weight,
  bloklar.N.ln1/ln2.{weight,bias},
  bloklar.N.attn.c_attn/c_proj.{weight,bias},
  bloklar.N.mlp.net.0/net.2.{weight,bias},
  ln_f.{weight,bias}, head.weight

Tokenizer: HuggingFace `tokenizers` bicimi (bpe.json).

Kullanim:
  python3 scripts/convert/pt-gpt2-to-gguf.py sft.pt bpe.json cikti.gguf
"""

import json
import struct
import sys

import torch

# -- GGUF ilkel yazicilari ----------------------------------------------------
# `gguf` paketini kullanmiyoruz: bu betigin torch disinda bagimliligi olmasin.

GGUF_MAGIC = b"GGUF"
GGUF_VERSION = 3
ALIGNMENT = 32

T_UINT32, T_INT32, T_FLOAT32, T_BOOL, T_STRING, T_ARRAY = 4, 5, 6, 7, 8, 9
TYPE_F32, TYPE_F16 = 0, 1

# Normal simge ile ozel (kontrol) simgeyi ayirmak zorunlu: ayirmazsak
# "<bos>" metin icinde gecince simge olarak yorumlanabilirdi.
TOKEN_TYPE_NORMAL, TOKEN_TYPE_CONTROL = 1, 3


def w_string(out, value: str) -> None:
    raw = value.encode("utf-8")
    out.write(struct.pack("<Q", len(raw)))
    out.write(raw)


def w_kv_string(out, key: str, value: str) -> None:
    w_string(out, key)
    out.write(struct.pack("<I", T_STRING))
    w_string(out, value)


def w_kv_u32(out, key: str, value: int) -> None:
    w_string(out, key)
    out.write(struct.pack("<II", T_UINT32, value))


def w_kv_bool(out, key: str, value: bool) -> None:
    w_string(out, key)
    out.write(struct.pack("<IB", T_BOOL, 1 if value else 0))


def w_kv_f32(out, key: str, value: float) -> None:
    w_string(out, key)
    out.write(struct.pack("<I", T_FLOAT32))
    out.write(struct.pack("<f", value))


def w_kv_str_array(out, key: str, values: list) -> None:
    w_string(out, key)
    out.write(struct.pack("<IIQ", T_ARRAY, T_STRING, len(values)))
    for item in values:
        w_string(out, item)


def w_kv_i32_array(out, key: str, values: list) -> None:
    w_string(out, key)
    out.write(struct.pack("<IIQ", T_ARRAY, T_INT32, len(values)))
    out.write(struct.pack(f"<{len(values)}i", *values))


# -- Tensor adlandirma --------------------------------------------------------


def map_names(state, n_layer: int):
    """Kaynak adlari llama.cpp'nin gpt2 mimarisinde bekledigi adlara esler."""
    out = [
        ("token_embd.weight", state["tok_emb.weight"]),
        ("position_embd.weight", state["pos_emb.weight"]),
    ]
    for i in range(n_layer):
        pairs = [
            (f"blk.{i}.attn_norm", f"bloklar.{i}.ln1"),
            (f"blk.{i}.attn_qkv", f"bloklar.{i}.attn.c_attn"),
            (f"blk.{i}.attn_output", f"bloklar.{i}.attn.c_proj"),
            (f"blk.{i}.ffn_norm", f"bloklar.{i}.ln2"),
            (f"blk.{i}.ffn_up", f"bloklar.{i}.mlp.net.0"),
            (f"blk.{i}.ffn_down", f"bloklar.{i}.mlp.net.2"),
        ]
        for dst, src in pairs:
            out.append((f"{dst}.weight", state[f"{src}.weight"]))
            out.append((f"{dst}.bias", state[f"{src}.bias"]))
    out.append(("output_norm.weight", state["ln_f.weight"]))
    out.append(("output_norm.bias", state["ln_f.bias"]))
    # Bagli agirlik olsa da ayri yazilir: gpt2 yukleyicisi output.weight ariyor.
    out.append(("output.weight", state["head.weight"]))
    return out


def tensor_bytes(tensor):
    """1 boyutlular F32, digerleri F16.

    LayerNorm olceklerini yarim hassasiyette birakmak cikisi gorunur sekilde
    bozuyor; llama.cpp'nin kendi cevirici betikleri de bunlari F32'ye cikarir.
    """
    if tensor.dim() == 1:
        return tensor.to(torch.float32).contiguous().numpy().tobytes(), TYPE_F32
    return tensor.to(torch.float16).contiguous().numpy().tobytes(), TYPE_F16


def pad_to(out, alignment: int) -> None:
    extra = (alignment - out.tell() % alignment) % alignment
    if extra:
        out.write(b"\0" * extra)


# -- Tokenizer ----------------------------------------------------------------


def build_vocab(tok: dict):
    """bpe.json'dan kimlik sirasina gore simge listesi ve tur dizisi uretir."""
    vocab = dict(tok["model"]["vocab"])
    added = {entry["id"]: entry for entry in tok.get("added_tokens", [])}
    for token_id, entry in added.items():
        vocab[entry["content"]] = token_id

    size = max(vocab.values()) + 1
    tokens = [""] * size
    types = [TOKEN_TYPE_NORMAL] * size
    for token, token_id in vocab.items():
        tokens[token_id] = token
    for token_id, entry in added.items():
        # Girinti simgeleri ozel degil, sadece sonradan eklenmis normal simge.
        if entry.get("special"):
            types[token_id] = TOKEN_TYPE_CONTROL

    missing = [i for i, token in enumerate(tokens) if token == ""]
    if missing:
        raise SystemExit(f"Sozlukte bosluk var: {missing[:10]}")

    merges = [" ".join(pair) for pair in tok["model"]["merges"]]
    return tokens, types, merges


def token_id(tok: dict, content: str):
    for entry in tok.get("added_tokens", []):
        if entry["content"] == content:
            return entry["id"]
    return tok["model"]["vocab"].get(content)


CHAT_TEMPLATE = (
    "{%- set sys = namespace(text='') -%}"
    "{%- for m in messages -%}"
    "{%- if m['role'] == 'system' -%}{%- set sys.text = m['content'] + '\n\n' -%}"
    "{%- elif m['role'] == 'user' -%}"
    "<kullanici>{{ sys.text + m['content'] }}<eos><asistan>"
    "{%- set sys.text = '' -%}"
    "{%- elif m['role'] == 'assistant' -%}{{ m['content'] }}<eos>"
    "{%- endif -%}"
    "{%- endfor -%}"
)


# -- Ana akis -----------------------------------------------------------------


def main() -> None:
    if len(sys.argv) != 4:
        raise SystemExit(f"kullanim: {sys.argv[0]} <sft.pt> <bpe.json> <cikti.gguf>")
    ckpt_path, tok_path, out_path = sys.argv[1:4]

    checkpoint = torch.load(ckpt_path, map_location="cpu", weights_only=False)
    config = checkpoint["ayar"]
    state = checkpoint["model"]
    tok = json.load(open(tok_path, encoding="utf-8"))

    n_embd = config["n_embd"]
    n_layer = config["n_layer"]
    tokens, types, merges = build_vocab(tok)

    if len(tokens) != config["vocab_size"]:
        raise SystemExit(
            f"Sozluk {len(tokens)} simge, model {config['vocab_size']} bekliyor."
        )

    tensors = map_names(state, n_layer)
    blobs = [(name, *tensor_bytes(tensor)) for name, tensor in tensors]

    name = out_path.rsplit("/", 1)[-1].removesuffix(".gguf")
    kv = [
        ("general.architecture", "gpt2", w_kv_string),
        ("general.name", name, w_kv_string),
        ("gpt2.context_length", config["block_size"], w_kv_u32),
        ("gpt2.embedding_length", n_embd, w_kv_u32),
        ("gpt2.feed_forward_length", 4 * n_embd, w_kv_u32),
        ("gpt2.block_count", n_layer, w_kv_u32),
        ("gpt2.attention.head_count", config["n_head"], w_kv_u32),
        ("gpt2.attention.layer_norm_epsilon", 1e-5, w_kv_f32),
        ("general.file_type", 1, w_kv_u32),
        ("tokenizer.ggml.model", "gpt2", w_kv_string),
        ("tokenizer.ggml.pre", "default", w_kv_string),
        # Egitim bicimi her ornekte <bos> ile basliyor. Eklemeyi unutmak
        # modeli dagilim disina cikariyor: kisa girdilerde ilk uretilen simge
        # dogrudan <eos> oluyor ve cevap bos donuyor ("selam" -> 30/30 bos).
        # Sablonda degil burada: ham /completion yolu da ayni girdiyi gorsun.
        ("tokenizer.ggml.add_bos_token", True, w_kv_bool),
        ("tokenizer.ggml.add_eos_token", False, w_kv_bool),
        # Sohbet sablonu GGUF'un icine gomulur; boylece arayuz ve ajan bu
        # modeli ozel bir kod yolu olmadan kullanabilir. Modelde sistem rolu
        # yok, sistem metni ilk kullanici turuna katlanir.
        ("tokenizer.chat_template", CHAT_TEMPLATE, w_kv_string),
    ]
    specials = [
        ("tokenizer.ggml.bos_token_id", token_id(tok, "<bos>")),
        ("tokenizer.ggml.eos_token_id", token_id(tok, "<eos>")),
        ("tokenizer.ggml.padding_token_id", token_id(tok, "<pad>")),
    ]

    kv_count = len(kv) + 3 + sum(1 for _, value in specials if value is not None)

    with open(out_path, "wb") as out:
        out.write(GGUF_MAGIC)
        out.write(struct.pack("<IQQ", GGUF_VERSION, len(blobs), kv_count))

        for key, value, writer in kv:
            writer(out, key, value)
        w_kv_str_array(out, "tokenizer.ggml.tokens", tokens)
        w_kv_i32_array(out, "tokenizer.ggml.token_type", types)
        w_kv_str_array(out, "tokenizer.ggml.merges", merges)
        for key, value in specials:
            if value is not None:
                w_kv_u32(out, key, value)

        offset = 0
        infos = []
        for tensor_name, raw, dtype in blobs:
            infos.append((tensor_name, raw, dtype, offset))
            offset += len(raw)
            offset += (ALIGNMENT - offset % ALIGNMENT) % ALIGNMENT

        for tensor_name, raw, dtype, tensor_offset in infos:
            shape = dict(tensors)[tensor_name].shape
            # GGUF boyut sirasi numpy'nin tersi: (cikis, giris) -> ne=[giris, cikis]
            dims = list(reversed(list(shape)))
            w_string(out, tensor_name)
            out.write(struct.pack("<I", len(dims)))
            out.write(struct.pack(f"<{len(dims)}Q", *dims))
            out.write(struct.pack("<IQ", dtype, tensor_offset))

        pad_to(out, ALIGNMENT)
        for _, raw, _, _ in infos:
            out.write(raw)
            pad_to(out, ALIGNMENT)

    total = sum(len(raw) for _, raw, _ in blobs)
    print(f"yazildi: {out_path}")
    print(f"  mimari gpt2 · {n_layer} katman · {n_embd} boyut · {len(tokens)} simge")
    print(f"  {len(blobs)} tensor · {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()

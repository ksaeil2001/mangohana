// Fixed offline assets. URLs record provenance only; this runtime never downloads.
export const MANGA_DETECTOR_FILE = {
  "path": "manga_det_v0.2.onnx",
  "url": "https://huggingface.co/Kellenok/PP-OCRv6_manga/resolve/c94f4a20677f1ba0c90625bccf42ea980f24e2f4/det/manga_det_v0.2.onnx",
  "size": 1816954,
  "sha256": "d132078c46e292b226fb5a2ca52a7612ad319262dfdf493e7d8e3be435295978"
} as const;

// Text-presence evidence only; Hayai remains the final text recognizer.
export const MANGA_TEXT_EVIDENCE_REC_FILE = {
  path: "rec/manga_rec_v0.2.onnx",
  url: "https://huggingface.co/Kellenok/PP-OCRv6_manga/resolve/c94f4a20677f1ba0c90625bccf42ea980f24e2f4/rec/manga_rec_v0.2.onnx",
  size: 21167540,
  sha256: "de12c84c63e62c80339e882e675983d886670dcb6f0147e1ed041afd6fa81888"
} as const;

export const MANGA_TEXT_EVIDENCE_DICT_FILE = {
  path: "ppocrv6_dict.txt",
  url: "https://huggingface.co/Kellenok/PP-OCRv6_manga/resolve/c94f4a20677f1ba0c90625bccf42ea980f24e2f4/ppocrv6_dict.txt",
  size: 74947,
  sha256: "b5f2bfe2bdd9448429e3e82b51c789775d9b42f2403d082b00662eb77e401c5d"
} as const;

export const HAYAI_MODEL_FILES = [
  {
    "path": "model.safetensors",
    "url": "https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova/resolve/2803d0dc005fa4396ab1e7c5a472d2c450a247f7/model.safetensors",
    "size": 627709088,
    "sha256": "ac63cd177c5b68bd91e18dd4408e0400461c7cf19f484b0da1643e232d1ffc3a"
  },
  {
    "path": "config.json",
    "url": "https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova/resolve/2803d0dc005fa4396ab1e7c5a472d2c450a247f7/config.json",
    "size": 367,
    "sha256": "880c99360c77733032fe06e94de8123dca21610cab782c6df43e4e26c9d37c41"
  },
  {
    "path": "configuration_hayai.py",
    "url": "https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova/resolve/2803d0dc005fa4396ab1e7c5a472d2c450a247f7/configuration_hayai.py",
    "size": 401,
    "sha256": "47abd38cf1bae7aef27d01f5b8b4aa0960a7bc625a8afad79c4762ff5e5ed970"
  },
  {
    "path": "modeling_hayai.py",
    "url": "https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova/resolve/2803d0dc005fa4396ab1e7c5a472d2c450a247f7/modeling_hayai.py",
    "size": 45551,
    "sha256": "3409131b4a35fc1bc1f0d7c40f906f79d10f57476f40fe05939c5a1a0ba9d527"
  },
  {
    "path": "tokenizer.json",
    "url": "https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova/resolve/2803d0dc005fa4396ab1e7c5a472d2c450a247f7/tokenizer.json",
    "size": 1247253,
    "sha256": "f8a0a909c628a684fe463094614e236a8b1d3609e7770f77e7beafaf1056bf13"
  },
  {
    "path": "tokenizer_config.json",
    "url": "https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova/resolve/2803d0dc005fa4396ab1e7c5a472d2c450a247f7/tokenizer_config.json",
    "size": 244,
    "sha256": "6fb6c69afaedf1275872d3e62e276fd4467bd00da7a84cbbb5566a2cd28f58f6"
  },
  {
    "path": "README.md",
    "url": "https://huggingface.co/JustANormalTinkerer/hayai-ocr-v2.5-nova/resolve/2803d0dc005fa4396ab1e7c5a472d2c450a247f7/README.md",
    "size": 10484,
    "sha256": "1ecc6eae28d5d8297c48592b288d9099943fe94ff4ad288923fed79df38c69ef"
  },
  {
    "path": "siglip/config.json",
    "url": "https://huggingface.co/google/siglip2-base-patch16-naflex/resolve/b53b807d3a2d5e2b3911292f2d69e5341cdc064c/config.json",
    "size": 329,
    "sha256": "c0b8c2e7f0527b0bea1b1d9abe0381c0f294352df92439c54590b8420e539118"
  },
  {
    "path": "siglip/preprocessor_config.json",
    "url": "https://huggingface.co/google/siglip2-base-patch16-naflex/resolve/b53b807d3a2d5e2b3911292f2d69e5341cdc064c/preprocessor_config.json",
    "size": 393,
    "sha256": "1125703e5446d5b6ff4d5893a33bac128cdd21dc12e3dad2469a648fb0ae3bf7"
  },
  {
    "path": "LICENSE",
    "url": "https://raw.githubusercontent.com/NopeNopeGuy/hayai-ocr/54c2771e11424f2c732cf32be22d616220ad8c4c/LICENSE",
    "size": 11357,
    "sha256": "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
  }
] as const;

export const HAYAI_CPU_RUNTIME_MANIFEST = {
  "id": "hayai-cpu-py310-v1",
  "files": [
    {
      "path": "certifi-2026.10.23-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/32/d1/a3652fe2c19134d0d15922177821d863cbd7e842d53a21bbe7e8e3a1b5ac/certifi-2026.10.23-py3-none-any.whl",
      "size": 135082,
      "sha256": "e9b54de76e530bb6cf0ccd036787103acb58fd42ba930ea8bf948ddbaa2f61d1"
    },
    {
      "path": "charset_normalizer-3.5.2-cp310-cp310-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/ae/ab/fb8b5178fdf7bf68efa61cbe892286bc9f73846f26147d4725fb89388475/charset_normalizer-3.5.2-cp310-cp310-win_amd64.whl",
      "size": 215446,
      "sha256": "1461ac396c4fdb983a675f20aa555624f0ee18ac83d832b9244ffff3d8055275"
    },
    {
      "path": "colorama-0.4.6-py2.py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/d1/d6/3965ed04c63042e047cb6a3e6ed1a63a35087b6a609aa3a15ed8ac56c221/colorama-0.4.6-py2.py3-none-any.whl",
      "size": 25335,
      "sha256": "4f1d9991f5acc0ca119f9d443620b77f9d6b33703e51011c16baf57afb285fc6"
    },
    {
      "path": "filelock-4.1.0-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/ee/86/032133892a5de43b5a98200b01aadcad68cc255e274a762f08b8a76d2912/filelock-4.1.0-py3-none-any.whl",
      "size": 133003,
      "sha256": "2ce9818e3e2d8f284c1a964414447ef148d42a5fd5e2a477a7118e574b293ec1"
    },
    {
      "path": "fsspec-2026.9.0-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/6c/c0/a98505f18594f1bce828bb159cec0fcf9860562f1a2c85913409fc8f3d9e/fsspec-2026.9.0-py3-none-any.whl",
      "size": 221738,
      "sha256": "8dd6e646e99ea382bd85f97a45e6b526a442d79423a7dc673f1e2756d05fcb5f"
    },
    {
      "path": "huggingface_hub-0.36.2-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/a8/af/48ac8483240de756d2438c380746e7130d1c6f75802ef22f3c6d49982787/huggingface_hub-0.36.2-py3-none-any.whl",
      "size": 566395,
      "sha256": "48f0c8eac16145dfce371e9d2d7772854a4f591bcb56c9cf548accf531d54270"
    },
    {
      "path": "idna-3.20-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/58/a2/bb081bab032533a855d44de1d56f8e8426114ff1ba5d1f07a438a0a654f8/idna-3.20-py3-none-any.whl",
      "size": 69583,
      "sha256": "ab7ae7122974553370f0bdb919e1a960b2cd1bc1ef0276416d896db81c14582c"
    },
    {
      "path": "jinja2-3.1.6-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/62/a1/3d680cbfd5f4b8f15abc1d571870c5fc3e594bb582bc3b64ea099db13e56/jinja2-3.1.6-py3-none-any.whl",
      "size": 134899,
      "sha256": "85ece4451f492d0c13c5dd7c13a64681a86afae63a5f347908daf103ce6d2f67"
    },
    {
      "path": "markupsafe-3.0.4-cp310-cp310-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/50/50/394a1c61c9b9972cb4f76875c332af7109bd39bdad09d3a0ec5327a339dc/markupsafe-3.0.4-cp310-cp310-win_amd64.whl",
      "size": 14329,
      "sha256": "5c22873ad1f0532ba40fa1727f3c0fc1bbbaab6d373d4cbe3f0dc74b2e2521c7"
    },
    {
      "path": "mpmath-1.3.0-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/43/e3/7d92a15f894aa0c9c4b49b8ee9ac9850d6e63b03c9c32c0367a13ae62209/mpmath-1.3.0-py3-none-any.whl",
      "size": 536198,
      "sha256": "a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c"
    },
    {
      "path": "networkx-3.4.2-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/b9/54/dd730b32ea14ea797530a4479b2ed46a6fb250f682a9cfb997e968bf0261/networkx-3.4.2-py3-none-any.whl",
      "size": 1723263,
      "sha256": "df5d4365b724cf81b8c6a7312509d0c22386097011ad1abe274afd5e9d3bbc5f"
    },
    {
      "path": "numpy-2.2.6-cp310-cp310-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/a3/dd/4b822569d6b96c39d1215dbae0582fd99954dcbcf0c1a13c61783feaca3f/numpy-2.2.6-cp310-cp310-win_amd64.whl",
      "size": 12904620,
      "sha256": "f0fd6321b839904e15c46e0d257fdd101dd7f530fe03fd6359c1ea63738703f3"
    },
    {
      "path": "packaging-26.3-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/63/34/ba1c580383c9eada3711951fef0795c80b829a078d72188184bcab9dd527/packaging-26.3-py3-none-any.whl",
      "size": 129956,
      "sha256": "d7193f7c8e4e93f444fde0262bf90af30e16fa0ad0ad44cb553c87339b23cd1c"
    },
    {
      "path": "pillow-12.1.0-cp310-cp310-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/d4/24/7d1c0e160b6b5ac2605ef7d8be537e28753c0db5363d035948073f5513d7/pillow-12.1.0-cp310-cp310-win_amd64.whl",
      "size": 7032367,
      "sha256": "64efdf00c09e31efd754448a383ea241f55a994fd079866b92d2bbff598aad91"
    },
    {
      "path": "pyyaml-6.0.3-cp310-cp310-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/2a/fa/926c003379b19fca39dd4634818b00dec6c62d87faf628d1394e137354d4/pyyaml-6.0.3-cp310-cp310-win_amd64.whl",
      "size": 158561,
      "sha256": "bdb2c67c6c1390b63c6ff89f210c8fd09d9a1217a465701eac7316313c915e4c"
    },
    {
      "path": "regex-2026.9.29-cp310-cp310-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/0c/f6/b127312ebc8092357f435c9e4594fd8cf50abb85f8b4b16ab8d262abab2a/regex-2026.9.29-cp310-cp310-win_amd64.whl",
      "size": 280629,
      "sha256": "23ae6fdad9e63e54038f5ef78aba2933faca61e24d432786589e737bc5522ebb"
    },
    {
      "path": "requests-2.34.2-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/a0/f4/c67b0b3f1b9245e8d266f0f112c500d50e5b4e83cb6f3b71b6528104182a/requests-2.34.2-py3-none-any.whl",
      "size": 73075,
      "sha256": "2a0d60c172f83ac6ab31e4554906c0f3b3588d37b5cb939b1c061f4907e278e0"
    },
    {
      "path": "safetensors-0.8.0-cp310-abi3-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/1b/6d/3fba214c1e5e0f69991677ec3bc17023f0421776975e1de0c682dca475e2/safetensors-0.8.0-cp310-abi3-win_amd64.whl",
      "size": 355540,
      "sha256": "096ec1a98435df7beb08853bb5aa9081a84f23d0adc67ed1a0a10550f608373f"
    },
    {
      "path": "sympy-1.14.0-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/a2/09/77d55d46fd61b4a135c444fc97158ef34a095e5681d0a6c10b75bf356191/sympy-1.14.0-py3-none-any.whl",
      "size": 6299353,
      "sha256": "e091cc3e99d2141a0ba2847328f5479b05d94a6635cb96148ccb3f34671bd8f5"
    },
    {
      "path": "tokenizers-0.22.2-cp39-abi3-win_amd64.whl",
      "url": "https://files.pythonhosted.org/packages/65/71/0670843133a43d43070abeb1949abfdef12a86d490bea9cd9e18e37c5ff7/tokenizers-0.22.2-cp39-abi3-win_amd64.whl",
      "size": 2747786,
      "sha256": "c9ea31edff2968b44a88f97d784c2f16dc0729b8b143ed004699ebca91f05c48"
    },
    {
      "path": "torch-2.10.0+cpu-cp310-cp310-win_amd64.whl",
      "url": "https://download-r2.pytorch.org/whl/cpu/torch-2.10.0%2Bcpu-cp310-cp310-win_amd64.whl",
      "size": 113634294,
      "sha256": "6c6f0df770144907092a0d067048d96ed4f278a6c840376d2ff0e27e7579b925"
    },
    {
      "path": "tqdm-4.70.1-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/a7/03/921a3d3c75785aca9ebfbfcabfbc3a1be12e2ab5265deb026d55a5a3f83e/tqdm-4.70.1-py3-none-any.whl",
      "size": 80199,
      "sha256": "c293e525e6fef9c20e8728fd4612df02a0aa31bb5fe91ecd93e123b1b7bffa73"
    },
    {
      "path": "transformers-4.57.6-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/03/b8/e484ef633af3887baeeb4b6ad12743363af7cce68ae51e938e00aaa0529d/transformers-4.57.6-py3-none-any.whl",
      "size": 11993498,
      "sha256": "4c9e9de11333ddfe5114bc872c9f370509198acf0b87a832a0ab9458e2bd0550"
    },
    {
      "path": "typing_extensions-4.16.0-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/49/d3/b8441a820a491ddfc024b0b0cf0393375b75ea13866d9c66727e54c2fc80/typing_extensions-4.16.0-py3-none-any.whl",
      "size": 45571,
      "sha256": "481caa481374e813c1b176ada14e97f1f67a4539ce9cfeb3f350d78d6370c2e8"
    },
    {
      "path": "urllib3-2.8.0-py3-none-any.whl",
      "url": "https://files.pythonhosted.org/packages/92/9d/c4e665119135114480843e7ab388fa94d8480650450e6f8e26b70d323a4c/urllib3-2.8.0-py3-none-any.whl",
      "size": 135717,
      "sha256": "0cf3cae568d36aa9576b28dfb35f11328f1cb974ca7647d9475ebb86c75ac6e3"
    }
  ]
} as const;

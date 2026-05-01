ExUnit.start()
Application.stop(:synthesis)
Mox.defmock(Synthesis.MockFetcher, for: Synthesis.FetcherBehaviour)
Mox.defmock(Synthesis.MockExtractor, for: Synthesis.ExtractorBehaviour)

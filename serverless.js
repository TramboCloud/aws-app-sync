const { Component } = require('@serverless/core')
const { isEmpty, isNil, map, merge, mergeDeepRight, not, pick } = require('ramda')

const {
  createOrUpdateApiKeys,
  createOrUpdateDataSources,
  createOrUpdateFunctions,
  createOrUpdateGraphqlApi,
  createOrUpdateResolvers,
  createSchema,
  createServiceRole,
  getClients,
  removeGraphqlApi,
  removeObsoleteApiKeys,
  removeObsoleteDataSources,
  removeObsoleteFunctions,
  removeObsoleteResolvers
} = require('./utils')

const defaults = {
  region: 'us-east-1'
}

class AwsAppSync extends Component {
  async default(inputs = {}) {
    const config = mergeDeepRight(merge(defaults, { apiId: this.state.apiId }), inputs)
    const { appSync } = getClients(this.context.credentials.aws, config.region)
    const graphqlApi = await createOrUpdateGraphqlApi(appSync, config, this.context.debug)
    config.apiId = graphqlApi.apiId || config.apiId
    config.arn = graphqlApi.arn
    config.uris = graphqlApi.uris
    config.isApiCreator = isNil(inputs.apiId)

    const awsIamRole = await this.load('@serverless/aws-iam-role')
    const serviceRole = await createServiceRole(awsIamRole, config, this.context.debug)

    config.dataSources = map((datasource) => {
      if (isNil(datasource.serviceRoleArn)) {
        datasource.serviceRoleArn = serviceRole.arn
      }
      return datasource
    }, config.dataSources || [])

    config.dataSources = await createOrUpdateDataSources(appSync, config, this.context.debug)
    config.schemaChecksum = await createSchema(appSync, config, this.state, this.context.debug)
    config.functions = await createOrUpdateFunctions(appSync, config, this.context.debug)
    config.mappingTemplates = await createOrUpdateResolvers(appSync, config, this.context.debug)
    config.apiKeys = await createOrUpdateApiKeys(appSync, config, this.state, this.context.debug)

    await removeObsoleteResolvers(appSync, config, this.state, this.context.debug)
    await removeObsoleteFunctions(appSync, config, this.state, this.context.debug)
    await removeObsoleteDataSources(appSync, config, this.state, this.context.debug)
    await removeObsoleteApiKeys(appSync, config, this.state, this.context.debug)

    this.state = pick(['arn', 'schemaChecksum', 'apiKeys', 'uris'], config)
    this.state.apiId = config.apiId
    this.state.isApiCreator = config.isApiCreator
    this.state.dataSources = map(pick(['name', 'type']), config.dataSources)
    this.state.mappingTemplates = map(pick(['type', 'field']), config.mappingTemplates)
    this.state.functions = map(pick(['name', 'dataSource', 'functionId']), config.functions) // deploy functions with same names is not possible
    await this.save()

    let output = pick(['apiId', 'arn', 'uris'], config)

    // Eslam - temporarly output a single url
    output.url = output.uris.GRAPHQL
    delete output.uris

    if (inputs.domain) {
      this.context.debug(`Setting domain ${inputs.domain} for AppSync API ${output.apiId}.`)
      const domain = await this.load('@serverless/domain', 'apiDomain')
      const subdomain = inputs.domain.split('.')[0]
      const secondLevelDomain = inputs.domain.replace(`${subdomain}.`, '')

      const domainInputs = {
        domain: secondLevelDomain,
        subdomains: {},
        region: config.region
      }

      domainInputs.subdomains[subdomain] = output
      const domainOutputs = await domain(domainInputs)

      output.domain = `${domainOutputs.domains[0]}/graphql`
    }

    if (not(isNil(config.apiKeys)) && not(isEmpty(config.apiKeys))) {
      output = merge(output, {
        apiKeys: map(({ id }) => id, config.apiKeys)
      })
    }

    return output
  }

  // eslint-disable-next-line no-unused-vars
  async remove(inputs = {}) {
    const config = mergeDeepRight(merge(defaults, { apiId: this.state.apiId }), inputs)
    const { appSync } = getClients(this.context.credentials.aws, config.region)
    if (not(this.state.isApiCreator)) {
      this.context.debug('Remove created resources from existing API without deleting the API.')
      await removeObsoleteResolvers(
        appSync,
        { apiId: this.state.apiId, mappingTemplates: [] },
        this.state,
        this.context.debug
      )
      await removeObsoleteFunctions(
        appSync,
        { apiId: this.state.apiId, functions: [] },
        this.state,
        this.context.debug
      )
      await removeObsoleteDataSources(
        appSync,
        { apiId: this.state.apiId, dataSources: [] },
        this.state,
        this.context.debug
      )
      await removeObsoleteApiKeys(
        appSync,
        { apiId: this.state.apiId, apiKeys: [] },
        this.context.debug
      )
    } else {
      await removeGraphqlApi(appSync, { apiId: this.state.apiId })
    }
    const awsIamRole = await this.load('@serverless/aws-iam-role')
    await awsIamRole.remove()

    const domain = await this.load('@serverless/domain', 'apiDomain')
    await domain.remove()

    this.state = {}
    await this.save()
  }
}

module.exports = AwsAppSync

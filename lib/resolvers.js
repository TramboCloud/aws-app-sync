const { checkForDuplicates, defaultToAnArray, equalsByKeys, listAll, readIfFile } = require('.')
const { difference, equals, find, isNil, map, not, flatten, merge, pick, pipe } = require('ramda')

/**
 * Create or update resolvers
 * @param {Object} appSync
 * @param {Object} config
 * @param {Function} debug
 * @return {Object} - deployed resolvers
 */
const createOrUpdateResolvers = async (appSync, config, debug) => {
  checkForDuplicates(['dataSource', 'type', 'field'], defaultToAnArray(config.mappingTemplates))
  const deployedResolvers = pipe(
    flatten,
    map((resolver) =>
      merge(resolver, {
        type: resolver.typeName,
        field: resolver.fieldName,
        dataSource: resolver.dataSourceName
      })
    )
  )(
    await Promise.all(
      map(
        async (mappingTemplate) =>
          listAll(
            appSync,
            'listResolvers',
            { apiId: config.apiId, typeName: mappingTemplate.type },
            'resolvers'
          ),
        defaultToAnArray(config.mappingTemplates)
      )
    )
  )

  const resolversWithTemplates = await Promise.all(
    map(async (resolver) => {
      let requestMappingTemplate = await readIfFile(resolver.request)
      let responseMappingTemplate = await readIfFile(resolver.response)

      if (isNil(requestMappingTemplate) || isNil(responseMappingTemplate)) {
        const { dataSource } = await appSync
          .getDataSource({ apiId: config.apiId, name: resolver.dataSource })
          .promise()
        if (equals(dataSource.type, 'AWS_LAMBDA')) {
          requestMappingTemplate =
            requestMappingTemplate ||
            '{ "version": "2017-02-28", "operation": "Invoke", "payload": $util.toJson($context.arguments) })'
          responseMappingTemplate = responseMappingTemplate || '$util.toJson($context.result)'
        }
      }

      return merge(resolver, { requestMappingTemplate, responseMappingTemplate })
    }, defaultToAnArray(config.mappingTemplates))
  )

  const resolversToDeploy = map((resolver) => {
    const deployedResolver = find(
      ({ type, field }) => equals(type, resolver.type) && equals(field, resolver.field),
      deployedResolvers
    )
    const resolverEquals = isNil(deployedResolver)
      ? false
      : equalsByKeys(
          ['dataSource', 'type', 'field', 'responseMappingTemplate', 'requestMappingTemplate'],
          deployedResolver,
          resolver
        )

    const mode = not(resolverEquals) ? (not(deployedResolver) ? 'create' : 'update') : 'ignore'
    return merge(resolver, { mode })
  }, resolversWithTemplates)

  return await Promise.all(
    map(async (resolver) => {
      let pipelineFunctions;
      if (equals(resolver.kind, 'PIPELINE') && not(isNil(resolver.pipelineConfig)) && not(isNil(resolver.pipelineConfig.functions))) {
        debug(`Mapping Function Name to Function Id for Pipeline Resolver "${resolver.field}...`)
        pipelineFunctions = map(pipelineFunctionName => {
          const { functionId } = find(
            ({ name }) => equals(name, pipelineFunctionName),
            config.functions
          )
          if (isNil(functionId)) { throw new Error(`A function "${pipelineFunctionName}" must exist before referencing them to a Pipeline Resolver."`) }
          return functionId
        }, resolver.pipelineConfig.functions)
      }
      const params = {
        apiId: config.apiId,
        fieldName: resolver.field,
        requestMappingTemplate: resolver.requestMappingTemplate,
        responseMappingTemplate: resolver.responseMappingTemplate,
        typeName: resolver.type,
        kind: resolver.kind,
      }

      if (equals(resolver.kind, 'PIPELINE')) {
        if (isNil(pipelineFunctions)) {
          params.pipelineConfig = {}
        } else {
          params.pipelineConfig = { functions: pipelineFunctions }
        }
        if (not(isNil(resolver.dataSource))) {
          throw new Error(`Please either remove "dataSource" or "kind" as 'PIPELINE' from resolver "${resolver.field}". AWS AppSync might not be reconfigured if you are trying to convert a regular resolver to be a pipeline resolver but not removing "dataSource".`)
        }
      } else {
        if (isNil(resolver.dataSource)) {
          throw new Error(`"dataSource" must be specified for resolver "${resolver.field}".`)
        }
        params.dataSourceName = resolver.dataSource
      }

      if (equals(resolver.mode, 'create')) {
        debug(`Creating resolver ${resolver.field}/${resolver.type}`)
        await appSync.createResolver(params).promise()
      } else if (equals(resolver.mode, 'update')) {
        debug(`Updating resolver ${resolver.field}/${resolver.type}`)
        await appSync.updateResolver(params).promise()
      }
      return Promise.resolve(resolver)
    }, resolversToDeploy)
  )
}

/**
 * Remove obsolete resolvers
 * @param {Object} appSync
 * @param {Object} config
 * @param {Object} state
 * @param {Function} debug
 */
const removeObsoleteResolvers = async (appSync, config, state, debug) => {
  const obsoleteResolvers = difference(
    defaultToAnArray(state.mappingTemplates),
    map(pick(['type', 'field']), defaultToAnArray(config.mappingTemplates))
  )
  await Promise.all(
    map(async (resolver) => {
      debug(`Removing resolver ${resolver.field}/${resolver.type}`)
      try {
        await appSync
          .deleteResolver({
            apiId: config.apiId,
            fieldName: resolver.field,
            typeName: resolver.type
          })
          .promise()
      } catch (error) {
        if (not(equals(error.code, 'NotFoundException'))) {
          throw error
        }
        debug(`Resolver ${resolver.field}/${resolver.type} already removed`)
      }
    }, obsoleteResolvers)
  )
}

module.exports = { createOrUpdateResolvers, removeObsoleteResolvers }
